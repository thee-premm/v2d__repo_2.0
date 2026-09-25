import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from root directory
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const env = {
  PORT: process.env.PORT || 5000,
  NODE_ENV: process.env.NODE_ENV || "development",
  DB: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "v2d_db",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "postgres",
  },
  REDIS: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  JWT: {
    secret:
      process.env.JWT_SECRET ||
      "v2d_super_secret_jwt_key_2026_campus_food_system",
    expiresIn: process.env.JWT_EXPIRES_IN || "24h",
  },
};