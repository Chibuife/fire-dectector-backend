const cron = require("node-cron");

// Function to delete documents older than 24 hours
async function clearOldData(db) {
  if (!db) {
    console.log("Database not connected. Cannot clear data.");
    return;
  }

  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const result = await db.collection("sensors").deleteMany({
      timestamp: { $lt: twentyFourHoursAgo }
    });

    console.log(`Cleared ${result.deletedCount} old records from database.`);
  } catch (err) {
    console.error("Error clearing old data:", err);
  }
}

// Schedule the cron job to run **every day at midnight**
module.exports = function crons(db) {
  cron.schedule("0 0 * * *", () => {
    console.log("Running daily cleanup task...");
    clearOldData(db);
  });
};
