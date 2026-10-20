-- Institutions created by the demo seed are flagged so every screen can label
-- their data as sample data. Real institutions are never flagged.
ALTER TABLE institutions ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE;
