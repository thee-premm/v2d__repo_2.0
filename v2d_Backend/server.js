import express from "express";
import cors from "cors";

import { env } from "./src/config/env.js";

import authRoutes from "./src/routes/authRoutes.js";
import mealRoutes from "./src/routes/mealRoutes.js";

const app = express();

// -------------------------
// Basic middleware
// -------------------------

app.use(cors());
app.use(express.json());

// -------------------------
// Health check
// -------------------------

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "V2D Backend is running",
  });
});

// -------------------------
// API Routes
// -------------------------

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/meals", mealRoutes);

// -------------------------
// Start server
// -------------------------

app.listen(env.PORT, () => {
  console.log(`🚀 V2D Backend running on port ${env.PORT}`);
  console.log(`📡 API: http://localhost:${env.PORT}/api/v1`);
});
