-- Plate and book photos picked from the gallery are stored first and read by AI in the background
ALTER TABLE "PlatePhoto" ADD COLUMN "readPending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BookPhoto" ADD COLUMN "readPending" BOOLEAN NOT NULL DEFAULT false;
