CREATE TABLE trip_exchange_rates (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  currency TEXT NOT NULL,
  rate_e8 INTEGER NOT NULL CHECK(rate_e8 BETWEEN 1 AND 1000000000000000),
  PRIMARY KEY(group_id, currency)
);

CREATE TRIGGER reset_trip_rates_on_currency_change
AFTER UPDATE OF currency ON groups
WHEN OLD.currency <> NEW.currency
BEGIN
  DELETE FROM trip_exchange_rates WHERE group_id = NEW.id;
END;
