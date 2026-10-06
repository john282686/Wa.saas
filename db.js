const { MongoClient } = require('mongodb');

let client = null;
let db = null;

async function connectDB() {
  if (db) return db;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db('wa_saas_v2');
  console.log('✅ MongoDB connected');
  return db;
}

function getDB() {
  if (!db) throw new Error('DB not connected');
  return db;
}

module.exports = { connectDB, getDB };
