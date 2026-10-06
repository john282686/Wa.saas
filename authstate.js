const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { getDB } = require('./db');

async function useMongoAuthState(telegramId) {
  const coll = getDB().collection('sessions');
  const key = `user_${telegramId}`;

  const writeData = async (data, id) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await coll.updateOne(
      { _id: `${key}-${id}` },
      { $set: { data: json, updated_at: new Date() } },
      { upsert: true }
    );
  };

  const readData = async (id) => {
    const doc = await coll.findOne({ _id: `${key}-${id}` });
    if (!doc) return null;
    try { return JSON.parse(doc.data, BufferJSON.reviver); }
    catch (e) { return null; }
  };

  const removeData = async (id) => {
    await coll.deleteOne({ _id: `${key}-${id}` });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const k = `${category}-${id}`;
              tasks.push(value ? writeData(value, k) : removeData(k));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
}

module.exports = { useMongoAuthState };
