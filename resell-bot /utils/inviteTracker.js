const { readDB, writeDB } = require('./db');

let cachedInvites = new Map();

async function startInviteTracker(client) {
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.log('⚠ Invite tracker: bot is not in any server yet — skipping.');
    return;
  }

  try {
    const invites = await guild.invites.fetch();
    invites.forEach(inv => cachedInvites.set(inv.code, inv.uses));
    console.log(`✅ Invite tracker started — cached ${invites.size} invites`);
  } catch (err) {
    if (err.code === 50013) {
      console.log('⚠ Invite tracker: missing "Manage Server" permission — invite tracking disabled. (Bot will keep running.)');
    } else {
      console.log(`⚠ Invite tracker could not start: ${err.message} (Bot will keep running.)`);
    }
  }
} catch (err) {
    if (err.code === 50013) {
      console.log('⚠ Invite tracker: missing "Manage Server" permission — invite tracking disabled. (Bot will keep running.)');
    } else {
      console.log(`⚠ Invite tracker could not start: ${err.message} (Bot will keep running.)`);
    }
  }
}

async function handleMemberJoin(member, client) {
  const guild = member.guild;
  const db = readDB('invites');

  try {
    const newInvites = await guild.invites.fetch();
    const usedInvite = newInvites.find(inv => {
      const cached = cachedInvites.get(inv.code);
      return cached !== undefined && inv.uses > cached;
    });

    newInvites.forEach(inv => cachedInvites.set(inv.code, inv.uses));

    if (usedInvite) {
      const inviterId = usedInvite.inviter?.id;
      if (inviterId) {
        if (!db.invites[inviterId]) {
          db.invites[inviterId] = { total: 0, valid: 0, left: 0, members: [] };
        }
        db.invites[inviterId].total++;
        db.invites[inviterId].valid++;
        db.invites[inviterId].members.push({
          userId: member.id,
          joinedAt: Date.now(),
          left: false,
        });
        writeDB('invites', db);
      }
    }
  } catch (err) {
    console.error('Invite tracking error on join:', err);
  }
}

function handleMemberLeave(member) {
  const db = readDB('invites');

  for (const [inviterId, data] of Object.entries(db.invites)) {
    const entry = data.members.find(m => m.userId === member.id && !m.left);
    if (entry) {
      entry.left = true;
      data.left++;
      data.valid = Math.max(0, data.valid - 1);
      break;
    }
  }

  writeDB('invites', db);
}

module.exports = { startInviteTracker, handleMemberJoin, handleMemberLeave };
