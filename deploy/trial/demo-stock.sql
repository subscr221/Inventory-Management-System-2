-- Practice catalogue for the store-assistant trial at SITE-A-9-2-9e924ed7.
-- Idempotent. The items desk shows these MK- codes, and Check stock reads the same rows.

INSERT INTO location_register (
  location_id, location_code, level, parent_location_id, site_id,
  zone_type, quarantine, status
)
VALUES
  ('11111111-1111-4111-8111-111111111101', 'TRIAL-BIN-A14', 'bin',
   'abc25634-4982-40e6-bc9c-bb59263959e2', 'abc25634-4982-40e6-bc9c-bb59263959e2',
   'general', false, 'active'),
  ('11111111-1111-4111-8111-111111111102', 'TRIAL-FG-STORE', 'bin',
   'abc25634-4982-40e6-bc9c-bb59263959e2', 'abc25634-4982-40e6-bc9c-bb59263959e2',
   'general', false, 'active'),
  ('11111111-1111-4111-8111-111111111103', 'TRIAL-HOLD', 'bin',
   'abc25634-4982-40e6-bc9c-bb59263959e2', 'abc25634-4982-40e6-bc9c-bb59263959e2',
   'quarantine', true, 'active'),
  ('11111111-1111-4111-8111-111111111104', 'TRIAL-TRANSIT', 'bin',
   'abc25634-4982-40e6-bc9c-bb59263959e2', 'abc25634-4982-40e6-bc9c-bb59263959e2',
   'staging', false, 'active')
ON CONFLICT (location_code) DO NOTHING;

INSERT INTO item_master (sku, uom, valuation_method, business_stream)
VALUES
  ('MK-ALU-1201', 'SHT', 'weighted_average', 'job_work'),
  ('MK-PNL-088', 'EA', 'weighted_average', 'job_work'),
  ('MK-CST-014', 'KG', 'weighted_average', 'job_work'),
  ('MK-TRF-4412', 'EA', 'weighted_average', 'job_work')
ON CONFLICT (sku) DO NOTHING;

INSERT INTO stock_balance (
  sku, location_id, location_code, lot_id, stock_class, on_hand, allocated, in_transit
)
VALUES
  ('MK-ALU-1201', '11111111-1111-4111-8111-111111111101', 'TRIAL-BIN-A14', 'TRIAL', 'owned', 42, 6, 0),
  ('MK-PNL-088', '11111111-1111-4111-8111-111111111102', 'TRIAL-FG-STORE', 'TRIAL', 'owned', 120, 18, 0),
  ('MK-CST-014', '11111111-1111-4111-8111-111111111103', 'TRIAL-HOLD', 'TRIAL', 'owned', 850, 850, 0),
  ('MK-TRF-4412', '11111111-1111-4111-8111-111111111104', 'TRIAL-TRANSIT', 'TRIAL', 'owned', 24, 24, 24)
ON CONFLICT ON CONSTRAINT uq_stock_balance_grain DO UPDATE
SET on_hand = EXCLUDED.on_hand,
    allocated = EXCLUDED.allocated,
    in_transit = EXCLUDED.in_transit,
    location_code = EXCLUDED.location_code,
    updated_at = now();
