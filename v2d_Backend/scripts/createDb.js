#!/usr/bin/env node
// Creates the configured database (DB_NAME) if it does not exist. Never drops anything.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { env } from "../src/config/env.js";
import { connectionConfig } from "../src/config/db.js";

export async function ensureDatabase(name = env.db.database) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error("Invalid database name");
  const client = new pg.Client(connectionConfig("postgres"));
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount) return false;
    await client.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
    return true;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const created = await ensureDatabase();
    console.log(created ? `Created database "${env.db.database}".` : `Database "${env.db.database}" already exists.`);
  } catch (err) {
    console.error(`Could not create database: ${err.message}`);
    process.exitCode = 1;
  }
}
