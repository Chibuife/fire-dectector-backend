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

async function sendPushNotification(fcmToken, message) {
  await admin.messaging().send({
    token: fcmToken,
    notification: {
      title: "🔥 Fire",
      body: message,
    },
    android: {
      priority: "high",
      notification: {
        channelId: "alarm-channel-v3",
        sound: "alarm.mp3",
      },
    },
  });
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
  const { deviceId, token } = req.body;

  if (!deviceId || !token) {
    return res.status(400).json({ message: "deviceId and token required" });
  }

  try {
    await db.collection("tokens").updateOne(
      { deviceId, token },
      { $set: { deviceId, token } },
      { upsert: true }
    );

    res.json({ message: "Token registered" });
  } catch (err) {
    console.error(" Error saving token:", err);
    res.status(500).json({ message: "Failed to save token" });
  }
});

app.get("/", (req, res) => {
  res.send("Backend + WebSocket running ");
});

// Endpoint to receive data from ESP32
app.post("/data", async (req, res) => {
  const { deviceId, temperature, smoke } = req.body;

  if (!db) return res.status(500).json({ message: "Database not connected" });

  const data = { deviceId, temperature, smoke, timestamp: new Date() };

  try {
    await db.collection("sensors").insertOne(data);

    // Emit to subscribed WebSocket clients
    if (clients[deviceId]) {
      clients[deviceId].forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(data));
        }
      });
    }

    //  Send push notification if smoke level high
    if (smoke > 10) {
      const tokens = await db.collection("tokens").find({ deviceId }).toArray();
    console.log("Received token:", tokens);

      for (let t of tokens) {
        await sendPushNotification(t.token, ` Smoke level: ${smoke} ppm`);
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
    console.error("Invalid token ❌", error);
  }
}

verifyFcmToken("fQmWbTgBRgeHc0rKFBdLrr:APA91bFVF_Kaj-ue-x8zq80GMmvPa3XXY5oPmTVsjx-DDY8XBpXekqB3Yheg1HltXzjPSSH5XMP5DVZFB8wN8diCVy1LseL4Hx67b3-rdCQz3aBwoAYT7YY");
    }

    res.json({ message: " Data stored and processed" });
  } catch (err) {
    console.error(" Error saving data:", err);
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
