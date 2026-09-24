function parseMentionText(text, guild = null) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  if (guild && guild.roles && guild.members) {
    let parsed = text;

    const roleEntries = Array.from(guild.roles.cache.values());
    for (const role of roleEntries) {
      if (!role || !role.name || role.name === '@everyone') continue;
      const regex = new RegExp(`(^|[^\\w])@${escapeRegex(role.name)}(?=$|[^\\w])`, 'gi');
      parsed = parsed.replace(regex, `$1<@&${role.id}>`);
    }

    const memberEntries = Array.from(guild.members.cache.values());
    for (const member of memberEntries) {
      if (!member || !member.user) continue;
      const username = member.user.username;
      const displayName = member.displayName || username;
      const namePatterns = [username, displayName];

      for (const name of namePatterns) {
        if (!name) continue;
        const regex = new RegExp(`(^|[^\\w])@${escapeRegex(name)}(?=$|[^\\w])`, 'gi');
        parsed = parsed.replace(regex, `$1<@${member.id}>`);
      }
    }

    return parsed;
  }

  return text;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  parseMentionText
};
