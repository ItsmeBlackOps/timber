// GET /v1/events backend (contract C10): distinct event names seen per app.

export async function runEvents(collection, { app } = {}) {
  const pipeline = [
    ...(app ? [{ $match: { app } }] : []),
    { $group: { _id: { app: '$app', event: '$event' } } },
    { $group: { _id: '$_id.app', events: { $addToSet: '$_id.event' } } },
    { $sort: { _id: 1 } },
  ];
  const rows = await collection.aggregate(pipeline).toArray();
  const apps = {};
  // rows arrive app-asc from $sort; insertion order keeps the response keys sorted.
  for (const row of rows) apps[row._id] = [...row.events].sort();
  return { apps };
}
