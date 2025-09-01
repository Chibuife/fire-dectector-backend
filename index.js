require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { MongoClient } = require("mongodb");
const crons = require("./util/crons");
const http = require("http");
const WebSocket = require("ws");
const { Expo } = require("expo-server-sdk");
const { channel } = require("diagnostics_channel");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;
const dbName = "esp32_data";

app.use(bodyParser.json());

let db;
const expo = new Expo(); // initialize expo SDK

// Connect to MongoDB
MongoClient.connect(process.env.MONGO_URI)
  .then(client => {
    console.log(" Connected to MongoDB");
    db = client.db(dbName);
    crons(db); // start cron jobs
  })
  .catch(err => console.error(" Failed to connect to MongoDB:", err));

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map deviceId -> array of connected WebSocket clients
const clients = {};

// async function sendPushNotification(expoPushToken, message) {
//   if (!Expo.isExpoPushToken(expoPushToken)) {
//     console.error(` Invalid Expo push token: ${expoPushToken}`);
//     return;
//   }

//   const messages = [{
//     to: expoPushToken,
//     sound: "default",
//     title: "🔥 Fire",
//     body: message,
//     priority: "high",
//     channelId: "alarm-channel-v3",
//     collapseId:"alarm-alert",
//     data: { smoke: true },
//   }];

//   console.log(message,"message")
//   try {
//     await expo.sendPushNotificationsAsync(messages);
//     console.log(" Notification sent:", message);
//   } catch (err) {
//     console.error(" Error sending notification:", err);
//   }
// }

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT in .env");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function sendPushNotification(token) {
  try {
    const message = {
      token: token,
      notification: {
        title: "🔥 Fire Alert",
        body: "Smoke detected in your room!",
      },
      data: {
        page: "/alert",
        deviceId: "ESP32-001",
        status: "ALERT",
      },
      android: {
        notification: {
          channelId: "alarm-channel-v3",   // 👈 must match exactly
          sound: "alarm",                  // your custom sound
          priority: "high",
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log("✅ Notification sent:", response);
  } catch (error) {
    console.error("❌ Error sending notification:", error);
  }

}

async function verifyFcmToken(token) {

  try {
    const response = await admin.messaging().send(
      {
        token,
        notification: {
          title: "Test",
          body: "Just verifying token",
        },
      },
      true // <-- dryRun = true
    );

    console.log("Valid token ✅", response);
  } catch (error) {
    console.error("Invalid token ❌", error, token);
  }
}

// Handle WebSocket connections
wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket");

  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.action === "subscribe" && msg.deviceId) {
        const deviceId = msg.deviceId;

        if (!clients[deviceId]) clients[deviceId] = [];
        clients[deviceId].push(ws);

        console.log(`Client subscribed to device ${deviceId}`);
      }
    } catch (err) {
      console.error("Invalid WebSocket message:", err);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
    for (const deviceId in clients) {
      clients[deviceId] = clients[deviceId].filter(c => c !== ws);
    }
  });
});

//  Register device token
app.post("/register-token", async (req, res) => {
  const { deviceId, token, smokeThreshold, tempThreshold,
    notificationsEnabled, } = req.body;

  if (!deviceId || !token) {
    return res.status(400).json({ message: "deviceId and token required" });
  }

  try {
    // await db.collection("tokens").updateOne(
    //   { deviceId, token },
    //   {
    //     $set: {
    //       deviceId, token, smokeThreshold, tempThreshold,
    //       notificationsEnabled,
    //     }
    //   },
    //   { upsert: true }
    // );


    await db.collection("tokens").updateMany(
      { token, deviceId: { $ne: deviceId } },
      { $set: { deviceId } }
    );

    await db.collection("tokens").updateOne(
      { deviceId },
      {
        $set: {
          token,
          smokeThreshold,
          tempThreshold,
          notificationsEnabled,
        },
      },
      { upsert: true }
    );

    res.json({ message: "Token registered" });
  } catch (err) {
    console.error(" Error saving token:", err);
    res.status(500).json({ message: "Failed to save token" });
  }
});

app.get("/settings/:deviceId", async (req, res) => {
  try {
    const { deviceId } = req.params;

    const settings = await db.collection("tokens").findOne({ deviceId });

    if (!settings) {
      return res.status(404).json({ message: "Settings not found" });
    }
    console.log("Fetched settings:", settings);
    res.json(settings);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ message: "Failed to fetch settings" });
  }
});

app.get("/", (req, res) => {
  res.send("Backend + WebSocket running ");
});

// Endpoint to receive data from ESP32
// app.post("/data", async (req, res) => {
//   const { deviceId, temperature, smoke } = req.body;

//   if (!db) return res.status(500).json({ message: "Database not connected" });

//   const data = { deviceId, temperature, smoke, timestamp: new Date() };

//   try {
//     await db.collection("sensors").insertOne(data);

//     // Emit to subscribed WebSocket clients
//     if (clients[deviceId]) {
//       clients[deviceId].forEach(ws => {
//         if (ws.readyState === WebSocket.OPEN) {
//           ws.send(JSON.stringify(data));
//         }
//       });
//     }

//     const devices = await db.collection("tokens").find({ notificationsEnabled: true }).toArray();

//     if (!devices.length) {
//       return res.json({ message: "No devices to notify" });
//     }

//     for (const device of devices) {
//       const { token, smokeThreshold, tempThreshold, deviceId } = device;

//       // Check thresholds
//       if (smoke > Number(smokeThreshold)) {
//         console.log(`⚠️ Smoke exceeded threshold for device ${deviceId}: ${smoke}`);
//         await sendPushNotification(token, `🚨 High smoke detected: ${smoke} ppm`);
//       }

//       if (temperature > Number(tempThreshold)) {
//         console.log(`⚠️ Temperature exceeded threshold for device ${deviceId}: ${temperature}`);
//         await sendPushNotification(token, `🔥 High temperature detected: ${temperature}°C`);
//       }
//     }

//     return res.json({ message: "Data processed and notifications sent" });
//     // res.json({ message: " Data stored and processed" });
//   } catch (err) {
//     console.error(" Error saving data:", err);
//     res.status(500).json({ message: "Failed to store data" });
//   }
// });
app.post("/data", async (req, res) => {
  const { deviceId: senderId, temperature, smoke } = req.body;

  if (!db) return res.status(500).json({ message: "Database not connected" });

  const data = { deviceId: senderId, temperature, smoke, timestamp: new Date() };

  try {
    await db.collection("sensors").insertOne(data);

    // Emit to subscribed WebSocket clients for the sender
    if (clients[senderId]) {
      clients[senderId].forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(data));
        }
      });
    }

    // Fetch devices with notifications enabled, excluding the sender
    const devices = await db.collection("tokens")
      .find({ notificationsEnabled: true, deviceId: { $ne: senderId } })
      .toArray();

    if (!devices.length) {
      return res.json({ message: "Data stored, no other devices to notify" });
    }

    for (const device of devices) {
      const { token, smokeThreshold, tempThreshold, deviceId } = device;

      if (smoke > Number(smokeThreshold)) {
        console.log(`⚠️ Smoke exceeded threshold for device ${deviceId}: ${smoke}`);
        await sendPushNotification(token, `🚨 High smoke detected: ${smoke} ppm`);
      }

      if (temperature > Number(tempThreshold)) {
        console.log(`⚠️ Temperature exceeded threshold for device ${deviceId}: ${temperature}`);
        await sendPushNotification(token, `🔥 High temperature detected: ${temperature}°C`);
      }
    }

    return res.json({ message: "Data processed and notifications sent to other devices" });
  } catch (err) {
    console.error("❌ Error saving data:", err);
    res.status(500).json({ message: "Failed to store data" });
  }
});


// Fetch historical data
app.get("/data", async (req, res) => {
  if (!db) return res.status(500).json({ message: "Database not connected" });

  try {
    const sensors = await db.collection("sensors").find({}).toArray();
    res.json(sensors);
  } catch (err) {
    console.error("Error fetching data:", err);
    res.status(500).json({ message: "Failed to fetch data" });
  }
});

app.get("/data/:deviceId", async (req, res) => {
  if (!db) return res.status(500).json({ message: "Database not connected" });

  const { deviceId } = req.params;

  try {
    const sensors = await db.collection("sensors").find({ deviceId }).toArray();
    res.json(sensors);
  } catch (err) {
    console.error("Error fetching device data:", err);
    res.status(500).json({ message: "Failed to fetch data" });
  }
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
