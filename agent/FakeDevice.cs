using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace HmsAttendance
{
    /// <summary>
    /// A ZKTeco terminal, made of sockets and nothing else.
    ///
    /// WHY THIS EXISTS.
    ///
    /// The first build of terminal mode read the user list perfectly and
    /// failed on the attendance list with "the terminal would not start a
    /// buffered read", which was wrong in every particular: the terminal had
    /// started it, had answered correctly, and its answer was sitting one
    /// place further down the socket.
    ///
    /// The cause was a single unread packet. A chunked read answers with
    /// three packets — PREPARE_DATA, DATA, and a bare ACK_OK — and the agent
    /// read two. The third stayed in the buffer, so the next command took it
    /// as its own answer, and from then on every reply belonged to the
    /// command before it. The user list still worked because it came first.
    /// The symptom appeared two commands away from the cause.
    ///
    /// Nothing that tests arithmetic can find that. It needs something on
    /// the other end of a socket that behaves like the device, including the
    /// part that is easy to forget. So this replays the exact sequence a real
    /// K50 produced, trailing acknowledgement and all, taken from a packet
    /// trace of one.
    ///
    /// It is not a simulator and does not try to be. It answers the handful
    /// of commands this agent sends, in the order it sends them, with
    /// correctly framed packets and correct reply numbering. That is enough
    /// to prove the conversation, which is the part that cannot be reasoned
    /// about.
    /// </summary>
    internal class FakeDevice : IDisposable
    {
        private const ushort MAGIC_1 = 0x5050;
        private const ushort MAGIC_2 = 0x7D82;

        private const ushort CMD_CONNECT = 1000;
        private const ushort CMD_EXIT = 1001;
        private const ushort CMD_ENABLEDEVICE = 1002;
        private const ushort CMD_DISABLEDEVICE = 1003;
        private const ushort CMD_AUTH = 1102;
        private const ushort CMD_ACK_OK = 2000;
        private const ushort CMD_PREPARE_DATA = 1500;
        private const ushort CMD_DATA = 1501;
        private const ushort CMD_FREE_DATA = 1502;
        private const ushort CMD_PREPARE_BUFFER = 1503;
        private const ushort CMD_READ_BUFFER = 1504;
        private const ushort CMD_ATTLOG_RRQ = 13;
        private const ushort CMD_USERTEMP_RRQ = 9;
        private const ushort CMD_GET_FREE_SIZES = 50;
        private const ushort CMD_GET_TIME = 201;

        private readonly TcpListener _listener;
        private readonly Thread _thread;
        private volatile bool _stop;

        /** The session id this fake hands out, as a real one does. */
        private const ushort SESSION = 0x5838;

        /** What the buffered read currently has waiting, by nothing at all. */
        private byte[] _pending = new byte[0];

        /**
         * Whether to send the trailing acknowledgement after the data.
         *
         * A real device always does. The switch exists so a test can turn it
         * off and prove the agent notices, rather than quietly reading the
         * wrong packet for the rest of the connection.
         */
        public bool SendTrailingAck = true;

        public readonly int Port;
        public readonly List<string> Seen = new List<string>();

        public FakeDevice()
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _thread = new Thread(Serve);
            _thread.IsBackground = true;
            _thread.Start();
        }

        public void Dispose()
        {
            _stop = true;
            try { _listener.Stop(); } catch { }
        }

        /* ------------------------------------------------- the data it holds */

        /// <summary>
        /// Two users, in the 72-byte layout current firmware uses.
        /// </summary>
        public static byte[] UserPayload()
        {
            byte[] a = User(1, "Yasir", "1");
            byte[] b = User(7, "Saleem", "7");
            byte[] all = new byte[4 + a.Length + b.Length];
            Buffer.BlockCopy(BitConverter.GetBytes(a.Length + b.Length), 0, all, 0, 4);
            Buffer.BlockCopy(a, 0, all, 4, a.Length);
            Buffer.BlockCopy(b, 0, all, 4 + a.Length, b.Length);
            return all;
        }

        private static byte[] User(int uid, string name, string userId)
        {
            /* <HB8s24sIx7sx24s : uid, privilege, password, name, card, pad,
             * group, pad, user_id */
            byte[] r = new byte[72];
            Buffer.BlockCopy(BitConverter.GetBytes((ushort)uid), 0, r, 0, 2);
            r[2] = 0;
            Put(r, 11, name, 24);
            Put(r, 48, userId, 24);
            return r;
        }

        /// <summary>
        /// Three punches, in the 40-byte layout, with the dates a real
        /// device would encode.
        /// </summary>
        public static byte[] AttendancePayload()
        {
            byte[][] recs = new byte[][] {
                Punch(1, "1", new DateTime(2026, 10, 10, 9, 14, 33), 1, 0),
                Punch(7, "7", new DateTime(2026, 10, 10, 9, 15, 2), 1, 0),
                /* Out of order on purpose: the agent has to sort. */
                Punch(1, "1", new DateTime(2026, 10, 9, 18, 2, 44), 1, 1)
            };
            int body = recs.Length * 40;
            byte[] all = new byte[4 + body];
            Buffer.BlockCopy(BitConverter.GetBytes(body), 0, all, 0, 4);
            for (int i = 0; i < recs.Length; i++)
                Buffer.BlockCopy(recs[i], 0, all, 4 + i * 40, 40);
            return all;
        }

        private static byte[] Punch(int uid, string userId, DateTime at,
            int status, int punch)
        {
            byte[] r = new byte[40];
            Buffer.BlockCopy(BitConverter.GetBytes((ushort)uid), 0, r, 0, 2);
            Put(r, 2, userId, 24);
            r[26] = (byte)status;
            Buffer.BlockCopy(BitConverter.GetBytes(Encode(at)), 0, r, 27, 4);
            r[31] = (byte)punch;
            return r;
        }

        private static uint Encode(DateTime d)
        {
            long t = ((long)(d.Year % 100) * 12 * 31 + ((d.Month - 1) * 31) + d.Day - 1);
            t = t * 86400 + d.Hour * 3600 + d.Minute * 60 + d.Second;
            return (uint)t;
        }

        private static void Put(byte[] into, int at, string s, int max)
        {
            byte[] b = Encoding.UTF8.GetBytes(s ?? "");
            Buffer.BlockCopy(b, 0, into, at, Math.Min(b.Length, max));
        }

        /* ------------------------------------------------------ the socket */

        private void Serve()
        {
            try
            {
                while (!_stop)
                {
                    using (TcpClient c = _listener.AcceptTcpClient())
                    using (NetworkStream n = c.GetStream())
                    {
                        Converse(n);
                    }
                }
            }
            catch { /* the listener was stopped */ }
        }

        private void Converse(NetworkStream n)
        {
            while (!_stop)
            {
                byte[] top;
                try { top = Read(n, 8); } catch { return; }

                int len = (int)BitConverter.ToUInt32(top, 4);
                byte[] payload = Read(n, len);

                ushort cmd = BitConverter.ToUInt16(payload, 0);
                ushort reply = BitConverter.ToUInt16(payload, 6);
                byte[] data = new byte[len - 8];
                Buffer.BlockCopy(payload, 8, data, 0, data.Length);

                lock (Seen) Seen.Add(cmd.ToString());

                switch (cmd)
                {
                    case CMD_CONNECT:
                    case CMD_AUTH:
                    case CMD_ENABLEDEVICE:
                    case CMD_DISABLEDEVICE:
                    case CMD_FREE_DATA:
                        Reply(n, CMD_ACK_OK, new byte[0], reply);
                        break;

                    case CMD_EXIT:
                        Reply(n, CMD_ACK_OK, new byte[0], reply);
                        return;

                    case CMD_GET_TIME:
                        Reply(n, CMD_ACK_OK,
                            BitConverter.GetBytes(Encode(new DateTime(2026, 10, 10, 15, 22, 32))),
                            reply);
                        break;

                    case CMD_GET_FREE_SIZES:
                    {
                        byte[] sizes = new byte[80];
                        Buffer.BlockCopy(BitConverter.GetBytes(58), 0, sizes, 4 * 4, 4);
                        Buffer.BlockCopy(BitConverter.GetBytes(61), 0, sizes, 6 * 4, 4);
                        Buffer.BlockCopy(BitConverter.GetBytes(3), 0, sizes, 8 * 4, 4);
                        Buffer.BlockCopy(BitConverter.GetBytes(100000), 0, sizes, 16 * 4, 4);
                        Reply(n, CMD_ACK_OK, sizes, reply);
                        break;
                    }

                    case CMD_PREPARE_BUFFER:
                    {
                        /* <bhii : 1, command, fct, ext */
                        ushort want = BitConverter.ToUInt16(data, 1);
                        _pending = want == CMD_ATTLOG_RRQ
                            ? AttendancePayload()
                            : want == CMD_USERTEMP_RRQ ? UserPayload() : new byte[0];

                        /* The data stat: a zero, then the size, twice. */
                        byte[] stat = new byte[13];
                        Buffer.BlockCopy(BitConverter.GetBytes(_pending.Length), 0, stat, 1, 4);
                        Buffer.BlockCopy(BitConverter.GetBytes(_pending.Length), 0, stat, 5, 4);
                        Reply(n, CMD_ACK_OK, stat, reply);
                        break;
                    }

                    case CMD_READ_BUFFER:
                    {
                        int start = BitConverter.ToInt32(data, 0);
                        int size = BitConverter.ToInt32(data, 4);
                        size = Math.Min(size, Math.Max(0, _pending.Length - start));

                        byte[] chunk = new byte[size];
                        if (size > 0) Buffer.BlockCopy(_pending, start, chunk, 0, size);

                        /*
                         * THREE PACKETS, all carrying the same reply number,
                         * sent without waiting to be asked. The third is the
                         * one the agent used to leave behind.
                         */
                        byte[] prep = new byte[8];
                        Buffer.BlockCopy(BitConverter.GetBytes(size), 0, prep, 0, 4);
                        Reply(n, CMD_PREPARE_DATA, prep, reply);
                        Reply(n, CMD_DATA, chunk, reply);
                        if (SendTrailingAck) Reply(n, CMD_ACK_OK, new byte[0], reply);
                        break;
                    }

                    default:
                        Reply(n, CMD_ACK_OK, new byte[0], reply);
                        break;
                }
            }
        }

        private void Reply(NetworkStream n, ushort code, byte[] data, ushort reply)
        {
            byte[] payload = new byte[8 + data.Length];
            Buffer.BlockCopy(BitConverter.GetBytes(code), 0, payload, 0, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(SESSION), 0, payload, 4, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(reply), 0, payload, 6, 2);
            Buffer.BlockCopy(data, 0, payload, 8, data.Length);

            byte[] framed = new byte[8 + payload.Length];
            Buffer.BlockCopy(BitConverter.GetBytes(MAGIC_1), 0, framed, 0, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(MAGIC_2), 0, framed, 2, 2);
            Buffer.BlockCopy(BitConverter.GetBytes(payload.Length), 0, framed, 4, 4);
            Buffer.BlockCopy(payload, 0, framed, 8, payload.Length);

            n.Write(framed, 0, framed.Length);
            n.Flush();
        }

        private static byte[] Read(NetworkStream n, int count)
        {
            byte[] b = new byte[count];
            int got = 0;
            while (got < count)
            {
                int r = n.Read(b, got, count - got);
                if (r <= 0) throw new EndOfStreamException();
                got += r;
            }
            return b;
        }
    }
}
