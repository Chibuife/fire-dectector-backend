require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { MongoClient } = require("mongodb");
const crons = require("./util/crons");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const PORT = 3000;
const dbName = "esp32_data";

app.use(bodyParser.json());

let db;

// Connect to MongoDB
MongoClient.connect(process.env.MONGO_URI)
  .then(client => {
    console.log("Connected to MongoDB");
    db = client.db(dbName);
    crons(db); // start cron jobs
  })
  .catch(err => console.error("Failed to connect to MongoDB:", err));

// Create HTTP server and WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map deviceId -> array of connected WebSocket clients
const clients = {};


async function sendPushNotification(expoPushToken, message) {
  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: expoPushToken,
      sound: "default",
      title: "🔥 Fire Alert",
      body: message,
      data: { someData: "goes here" },
    }),
  });
}

// Handle WebSocket connections
wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket");

  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);

      // Subscribe to a device room
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
    // Remove ws from all device subscriptions
    for (const deviceId in clients) {
      clients[deviceId] = clients[deviceId].filter(c => c !== ws);
    }
  });
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

    if (smoke > 10) { 
      const tokens = await db.collection("tokens").find({ deviceId }).toArray();
      tokens.forEach(t => sendPushNotification(t.token, `Smoke level: ${smoke} ppm`));
    }

    res.json({ message: "Data stored and sent to WebSocket clients" });
  } catch (err) {
    console.error("Error saving data:", err);
    res.status(500).json({ message: "Failed to store data" });
  }
});

// Optional: GET endpoints to fetch historical data
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
