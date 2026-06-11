import { MongoClient } from 'mongodb';

// C7 index set. Key insertion order is load-bearing for compound indexes.
const INDEX_SPECS = [
  { key: { receivedAt: -1 } },
  { key: { app: 1, receivedAt: -1 } },
  { key: { event: 1, receivedAt: -1 } },
  { key: { level: 1, receivedAt: -1 } },
  { key: { 'ids.requestId': 1 }, sparse: true },
  { key: { 'ids.taskId': 1 }, sparse: true },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
];

export function buildClientOptions() {
  return { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 };
}

export async function connectMongo(uri, { dbName, collectionName }) {
  const client = new MongoClient(uri, buildClientOptions());
  await client.connect();
  const collection = client.db(dbName).collection(collectionName);
  return { client, collection };
}

export async function ensureIndexes(collection) {
  // createIndexes is a server-side no-op for indexes that already exist.
  await collection.createIndexes(structuredClone(INDEX_SPECS));
}
