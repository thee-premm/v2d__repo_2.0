// Must be the first import of every test file: it fixes the environment
// before src/config/env.js reads it.
process.env.NODE_ENV = "test";
process.env.DB_NAME = process.env.TEST_DB_NAME || "v2d_test";
process.env.SCHEDULER_ENABLED = "false";
process.env.MAIL_TRANSPORT = process.env.MAIL_TRANSPORT || "log";
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || "error";
process.env.APP_ORIGIN = "http://localhost:5173";

if (!process.env.DB_NAME.endsWith("_test")) {
  throw new Error(`Refusing to run tests against "${process.env.DB_NAME}": test database names must end in _test`);
}
