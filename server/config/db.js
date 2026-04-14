const mongoose = require("mongoose");

/**
 * Connects to MongoDB Atlas using the MONGO_URI from .env
 * Exits the process on failure so you get a clear error immediately.
 */
async function connectDB() {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // These options silence deprecation warnings in mongoose 8+
      // (they are the defaults, but being explicit is clearer)
    });
    console.log(`✅  MongoDB connected: ${conn.connection.host}`);
  } catch (err) {
    console.error("❌  MongoDB connection failed:", err.message);
    console.error(
      "    Check your MONGO_URI in server/.env and ensure your IP is whitelisted in Atlas."
    );
    process.exit(1);
  }
}

module.exports = connectDB;
