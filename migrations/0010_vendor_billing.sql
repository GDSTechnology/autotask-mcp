-- 0010_vendor_billing — vendor purchasing & billing reconciliation, P0 foundation
-- (GDS Vendor-Agnostic Reconciliation requirements v1.0, 2026-10-11).
--
-- Vendor-neutral: a vendor adapter (Pax8 first) turns each invoice into
-- normalized lines; everything downstream — mappings, reconciliation, change
-- plans — keys on (vendor, …) only. Read-only toward Autotask at this stage.
--
--   vendor_source_document  one imported invoice file (sha256 → idempotent re-import)
--   vendor_invoice_line     EVERY line of it, classified, with the original row in raw
--   vendor_customer_mapping vendor customer ↔ Autotask company (or internal / ignore)
--   canonical_offering      the manufacturer's product — what contracts are matched on
--   vendor_offering_mapping vendor SKU → offering (switching distributor = remapping SKUs)
--   catalog_offering_link   Autotask Service / Product / Bundle → offering + term
-- Mappings are versioned: a change supersedes the row (superseded_at) instead
-- of overwriting it, so every earlier decision and who made it is kept.

CREATE TABLE IF NOT EXISTS vendor_source_document (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor            text        NOT NULL,
  vendor_account_id text,
  invoice_number    text,
  invoice_date      date,
  file_name         text,
  sha256            text        NOT NULL UNIQUE,
  format            text        NOT NULL,
  currency          text        NOT NULL DEFAULT 'USD',
  line_count        integer     NOT NULL,
  line_total        numeric(14, 2),
  warnings          jsonb,
  imported_by       text,
  imported_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendor_source_document_vendor ON vendor_source_document (vendor, invoice_date);

CREATE TABLE IF NOT EXISTS vendor_invoice_line (
  id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id           bigint      NOT NULL REFERENCES vendor_source_document (id) ON DELETE CASCADE,
  vendor                text        NOT NULL,
  line_key              text        NOT NULL,
  vendor_customer_id    text,
  vendor_customer_name  text,
  subscription_id       text,
  sku                   text,
  description           text        NOT NULL,
  charge_class          text        NOT NULL,
  cadence               text        NOT NULL,
  billing_term          text,
  commitment_term       text,
  unit                  text,
  quantity              numeric(14, 4),
  unit_cost             numeric(14, 6),
  cost_total            numeric(14, 2),
  vendor_suggested_price numeric(14, 6),
  period_start          date,
  period_end            date,
  renewal_date          date,
  currency              text        NOT NULL,
  tax                   numeric(14, 2),
  fees                  numeric(14, 2),
  flags                 text[]      NOT NULL DEFAULT '{}',
  raw                   jsonb       NOT NULL,
  UNIQUE (document_id, line_key)
);
CREATE INDEX IF NOT EXISTS vendor_invoice_line_customer ON vendor_invoice_line (vendor, vendor_customer_id);
CREATE INDEX IF NOT EXISTS vendor_invoice_line_sku      ON vendor_invoice_line (vendor, sku);

CREATE TABLE IF NOT EXISTS vendor_customer_mapping (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor              text        NOT NULL,
  vendor_customer_id  text        NOT NULL,
  vendor_customer_name text,
  -- mapped (to autotask_company_id) | internal (GDS's own use) | ignore
  status              text        NOT NULL,
  autotask_company_id bigint,
  method              text        NOT NULL,   -- exact-name | normalized-name | manual | …
  confidence          text        NOT NULL,   -- confirmed | high | medium | low
  note                text,
  decided_by          text,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  superseded_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_customer_mapping_current ON vendor_customer_mapping (vendor, vendor_customer_id) WHERE superseded_at IS NULL;

-- The PRODUCT, not the sales channel: a canonical offering is the manufacturer's
-- product ("Microsoft | Microsoft 365 Business Standard"). Contracts never name
-- the vendor; a vendor SKU maps to an offering, and Autotask Services / Products
-- / Bundles map to offerings too (one offering often has several services — per
-- term). Changing distributor = remapping its SKUs; contracts are untouched.
CREATE TABLE IF NOT EXISTS canonical_offering (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manufacturer  text        NOT NULL,
  name          text        NOT NULL,
  -- the manufacturer's own product id when known (e.g. a Microsoft product id)
  manufacturer_product_id text,
  unit          text,
  -- recurring | usage | one_time | fee | internal — what kind of thing it is
  kind          text        NOT NULL DEFAULT 'recurring',
  notes         text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manufacturer, name)
);

-- vendor SKU -> offering (versioned)
CREATE TABLE IF NOT EXISTS vendor_offering_mapping (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor        text        NOT NULL,
  sku           text        NOT NULL,
  -- mapped (to offering_id) | not_billable (vendor-only charge: surcharge, fee) | ignore
  status        text        NOT NULL,
  offering_id   bigint      REFERENCES canonical_offering (id),
  method        text        NOT NULL,
  confidence    text        NOT NULL,
  note          text,
  decided_by    text,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_offering_mapping_current ON vendor_offering_mapping (vendor, sku) WHERE superseded_at IS NULL;

-- Autotask catalog item -> offering + the term it sells (versioned)
CREATE TABLE IF NOT EXISTS catalog_offering_link (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  autotask_entity text        NOT NULL,   -- Services | Products | ServiceBundles
  autotask_id     bigint      NOT NULL,
  offering_id     bigint      NOT NULL REFERENCES canonical_offering (id),
  -- MM | AM | AA | monthly | annual | one_time | none ('' = not stated)
  cadence         text        NOT NULL DEFAULT '',
  method          text        NOT NULL,
  confidence      text        NOT NULL,
  note            text,
  decided_by      text,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  superseded_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_offering_link_current ON catalog_offering_link (autotask_entity, autotask_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS catalog_offering_link_offering ON catalog_offering_link (offering_id) WHERE superseded_at IS NULL;

-- The vendor's own customer ↔ PSA crosswalk, as imported (Pax8: PSA admin →
-- Mappings → Download company report). Evidence for customer mappings, kept
-- raw; vendor_customer_mapping holds the decisions.
CREATE TABLE IF NOT EXISTS vendor_customer_crosswalk (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor               text        NOT NULL,
  vendor_customer_ref  text        NOT NULL,   -- the vendor's id in the report (Pax8: company UUID)
  vendor_customer_name text        NOT NULL,
  autotask_company_id  bigint,
  autotask_company_name text,
  document_sha256      text        NOT NULL,
  imported_by          text,
  imported_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, vendor_customer_ref, document_sha256)
);
CREATE INDEX IF NOT EXISTS vendor_customer_crosswalk_name ON vendor_customer_crosswalk (vendor, lower(vendor_customer_name));
