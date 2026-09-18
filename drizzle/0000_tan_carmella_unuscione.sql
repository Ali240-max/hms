CREATE TYPE "public"."dispense_status" AS ENUM('pending', 'partial', 'dispensed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."drug_schedule" AS ENUM('otc', 'g', 'controlled', 'refrigerated');--> statement-breakpoint
CREATE TYPE "public"."earning_source" AS ENUM('consultation', 'service');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other');--> statement-breakpoint
CREATE TYPE "public"."movement_reason" AS ENUM('purchase', 'sale', 'sale_return', 'purchase_return', 'expiry_writeoff', 'damage', 'stock_count');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('ordered', 'paid', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pay_method" AS ENUM('cash', 'card', 'easypaisa', 'jazzcash', 'credit');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('completed', 'voided', 'returned');--> statement-breakpoint
CREATE TYPE "public"."service_category" AS ENUM('lab', 'radiology', 'procedure', 'other');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('admin', 'receptionist', 'doctor', 'pharmacist');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('waiting', 'in_consultation', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"batch_no" text NOT NULL,
	"expiry_date" date NOT NULL,
	"cost_paisa" bigint NOT NULL,
	"price_paisa" bigint NOT NULL,
	"qty_on_hand" integer DEFAULT 0 NOT NULL,
	"supplier_id" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"doctor_id" integer NOT NULL,
	"visit_id" integer,
	"source" "earning_source" NOT NULL,
	"ref_table" text,
	"ref_id" integer,
	"description" text NOT NULL,
	"gross_paisa" bigint NOT NULL,
	"share_bp" integer NOT NULL,
	"amount_paisa" bigint NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_service_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"doctor_id" integer NOT NULL,
	"service_id" integer NOT NULL,
	"share_bp" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"specialisation" text,
	"qualification" text,
	"room" text,
	"consultation_fee_paisa" bigint DEFAULT 0 NOT NULL,
	"consultation_share_bp" integer DEFAULT 10000 NOT NULL,
	"default_service_share_bp" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" serial PRIMARY KEY NOT NULL,
	"mrn" text NOT NULL,
	"name" text NOT NULL,
	"father_name" text,
	"phone" text,
	"gender" "gender",
	"date_of_birth" date,
	"age_years" integer,
	"cnic" text,
	"address" text,
	"blood_group" text,
	"allergies" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescription_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"prescription_id" integer NOT NULL,
	"product_id" integer,
	"drug_name" text NOT NULL,
	"dose" text,
	"frequency" text,
	"duration_days" integer,
	"qty_prescribed" integer DEFAULT 1 NOT NULL,
	"qty_dispensed" integer DEFAULT 0 NOT NULL,
	"instructions" text,
	"status" "dispense_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"visit_id" integer NOT NULL,
	"doctor_id" integer NOT NULL,
	"diagnosis" text,
	"advice" text,
	"follow_up_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"barcode" text,
	"product_code" text,
	"name" text NOT NULL,
	"generic_name" text,
	"manufacturer" text,
	"form" text,
	"strength" text,
	"pack_size" integer DEFAULT 1 NOT NULL,
	"unit_label" text DEFAULT 'unit' NOT NULL,
	"sub_unit_label" text,
	"allow_loose" boolean DEFAULT false NOT NULL,
	"schedule" "drug_schedule" DEFAULT 'otc' NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"rack_location" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_id" integer NOT NULL,
	"batch_id" integer NOT NULL,
	"qty" integer NOT NULL,
	"unit_cost_paisa" bigint NOT NULL,
	"bonus_qty" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer NOT NULL,
	"supplier_invoice_no" text NOT NULL,
	"invoice_date" date NOT NULL,
	"total_paisa" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"received_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"sale_id" integer NOT NULL,
	"batch_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"product_name" text NOT NULL,
	"batch_no" text NOT NULL,
	"expiry_date" date NOT NULL,
	"qty" integer NOT NULL,
	"sold_as" text DEFAULT 'pack' NOT NULL,
	"display_qty" integer DEFAULT 1 NOT NULL,
	"unit_price_paisa" bigint NOT NULL,
	"unit_cost_paisa" bigint NOT NULL,
	"discount_paisa" bigint DEFAULT 0 NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"line_tax_paisa" bigint DEFAULT 0 NOT NULL,
	"line_total_paisa" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_no" text NOT NULL,
	"invoice_seq" integer DEFAULT 0 NOT NULL,
	"visit_id" integer,
	"patient_id" integer,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_name" text,
	"customer_phone" text,
	"doctor_name" text,
	"subtotal_paisa" bigint NOT NULL,
	"discount_paisa" bigint DEFAULT 0 NOT NULL,
	"tax_paisa" bigint DEFAULT 0 NOT NULL,
	"total_paisa" bigint NOT NULL,
	"paid_paisa" bigint DEFAULT 0 NOT NULL,
	"pay_method" "pay_method" DEFAULT 'cash' NOT NULL,
	"status" "sale_status" DEFAULT 'completed' NOT NULL,
	"cashier" text,
	"cashier_staff_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"visit_id" integer NOT NULL,
	"service_id" integer NOT NULL,
	"doctor_id" integer NOT NULL,
	"service_name" text NOT NULL,
	"price_paisa" bigint NOT NULL,
	"share_bp" integer DEFAULT 0 NOT NULL,
	"share_paisa" bigint DEFAULT 0 NOT NULL,
	"status" "order_status" DEFAULT 'ordered' NOT NULL,
	"note" text,
	"ordered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"category" "service_category" DEFAULT 'lab' NOT NULL,
	"price_paisa" bigint DEFAULT 0 NOT NULL,
	"default_share_bp" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"department_id" integer,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"qty_delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" "movement_reason" NOT NULL,
	"ref_table" text,
	"ref_id" integer,
	"note" text,
	"actor" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"address" text,
	"ntn" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"visit_no" text NOT NULL,
	"token_no" integer NOT NULL,
	"patient_id" integer NOT NULL,
	"doctor_id" integer NOT NULL,
	"department_id" integer,
	"status" "visit_status" DEFAULT 'waiting' NOT NULL,
	"consultation_fee_paisa" bigint DEFAULT 0 NOT NULL,
	"fee_paid" boolean DEFAULT false NOT NULL,
	"complaint" text,
	"registered_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_earnings" ADD CONSTRAINT "doctor_earnings_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_earnings" ADD CONSTRAINT "doctor_earnings_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_service_shares" ADD CONSTRAINT "doctor_service_shares_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_service_shares" ADD CONSTRAINT "doctor_service_shares_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_staff_id_staff_id_fk" FOREIGN KEY ("cashier_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_orders" ADD CONSTRAINT "service_orders_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_registered_by_staff_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_product_batchno_uq" ON "batches" USING btree ("product_id","batch_no");--> statement-breakpoint
CREATE INDEX "batches_fefo_idx" ON "batches" USING btree ("product_id","expiry_date");--> statement-breakpoint
CREATE INDEX "batches_expiry_idx" ON "batches" USING btree ("expiry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_code_uq" ON "departments" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "doctor_earnings_doctor_idx" ON "doctor_earnings" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "doctor_earnings_earned_idx" ON "doctor_earnings" USING btree ("earned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_earnings_ref_uq" ON "doctor_earnings" USING btree ("source","ref_table","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_service_share_uq" ON "doctor_service_shares" USING btree ("doctor_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doctors_staff_uq" ON "doctors" USING btree ("staff_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_mrn_uq" ON "patients" USING btree ("mrn");--> statement-breakpoint
CREATE INDEX "patients_phone_idx" ON "patients" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "patients_name_idx" ON "patients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "patients_cnic_idx" ON "patients" USING btree ("cnic");--> statement-breakpoint
CREATE INDEX "prescription_items_presc_idx" ON "prescription_items" USING btree ("prescription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prescriptions_visit_uq" ON "prescriptions" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_barcode_uq" ON "products" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "products_generic_idx" ON "products" USING btree ("generic_name");--> statement-breakpoint
CREATE INDEX "products_code_idx" ON "products" USING btree ("product_code");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_supplier_invoice_uq" ON "purchases" USING btree ("supplier_id","supplier_invoice_no");--> statement-breakpoint
CREATE INDEX "purchases_supplier_idx" ON "purchases" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "sale_items_sale_idx" ON "sale_items" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_items_batch_idx" ON "sale_items" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoice_uq" ON "sales" USING btree ("invoice_no");--> statement-breakpoint
CREATE INDEX "sales_sold_at_idx" ON "sales" USING btree ("sold_at");--> statement-breakpoint
CREATE INDEX "sales_invoice_seq_idx" ON "sales" USING btree ("invoice_seq");--> statement-breakpoint
CREATE INDEX "sales_visit_idx" ON "sales" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "service_orders_visit_idx" ON "service_orders" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "service_orders_doctor_idx" ON "service_orders" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "service_orders_ordered_idx" ON "service_orders" USING btree ("ordered_at");--> statement-breakpoint
CREATE INDEX "services_name_idx" ON "services" USING btree ("name");--> statement-breakpoint
CREATE INDEX "services_category_idx" ON "services" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_username_uq" ON "staff" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "staff_role_idx" ON "staff" USING btree ("role");--> statement-breakpoint
CREATE INDEX "stock_ledger_batch_idx" ON "stock_ledger" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_occurred_idx" ON "stock_ledger" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "visits_visit_no_uq" ON "visits" USING btree ("visit_no");--> statement-breakpoint
CREATE INDEX "visits_patient_idx" ON "visits" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "visits_doctor_idx" ON "visits" USING btree ("doctor_id");--> statement-breakpoint
CREATE INDEX "visits_created_idx" ON "visits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "visits_status_idx" ON "visits" USING btree ("status");