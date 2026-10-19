-- Browser request identity and original receipt revision share the cancel commit.
ALTER TABLE production_cancellations ADD COLUMN request_revision INTEGER CHECK(request_revision>=0);
ALTER TABLE production_cancellations ADD COLUMN receipt_revision INTEGER CHECK(receipt_revision>=0);
