// index.js
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionFlagsBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';

const { DISCORD_TOKEN } = process.env;

// ---------- Figure out where index.js actually lives ----------
const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);

// IMPORTANT: guildSettings.json will now ALWAYS live next to index.js
const SETTINGS_PATH = path.join(__dirname, 'guildSettings.json');

console.log('🔎 Process CWD:', process.cwd());
console.log('📄 index.js directory (__dirname):', __dirname);
console.log('📁 guildSettings.json path:', SETTINGS_PATH);

// Quick FS test so we know if writes work at all
try {
  fs.writeFileSync(path.join(__dirname, 'fs-test.txt'), 'fs test ok\n');
  console.log('✅ FS test: successfully wrote fs-test.txt');
} catch (e) {
  console.error('❌ FS test failed: could not write fs-test.txt', e);
}

// ---------- Persistent per-guild settings (JSON file) ----------
/**
 * guildSettings structure:
 * {
 *   [guildId]: {
 *     verificationChannelId?: string,
 *     staffChannelId?: string,
 *     roleAId?: string,
 *     roleBId?: string,
 *     notVerifiedRoleId?: string,  // auto-assigned on join, removed on verification
 *     modRoleId?: string,
 *     // Each verifyRoles entry = one button which can assign MULTIPLE roles
 *     verifyRoles?: [{
 *       roleIds: string[],   // one or more role IDs
 *       label: string        // button text
 *     }],
 *     welcomeTitle?: string,
 *     welcomeDescription?: string
 *   }
 * }
 */
let guildSettings = {};

try {
  if (fs.existsSync(SETTINGS_PATH)) {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    guildSettings = JSON.parse(raw || '{}');
    console.log('📂 Loaded existing guildSettings.json');
  } else {
    guildSettings = {};
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(guildSettings, null, 2));
    console.log('🆕 Created new empty guildSettings.json');
  }
} catch (e) {
  console.error('❌ Error while initializing guildSettings.json:', e);
  guildSettings = {};
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(guildSettings, null, 2));
    console.log('💾 Saved guildSettings.json');
  } catch (e) {
    console.error('❌ Failed to write guildSettings.json:', e);
  }
}

function getGuildConfig(guildId) {
  return guildSettings[guildId];
}

function updateGuildConfig(guildId, partial) {
  const existing = guildSettings[guildId] || {};
  guildSettings[guildId] = { ...existing, ...partial };
  console.log(`🛠 Updated config for guild ${guildId}:`, guildSettings[guildId]);
  saveSettings();
}

// ---------- Client setup ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

const isImageAttachment = (att) =>
  Boolean(att?.contentType?.startsWith('image/')) ||
  /\.(png|jpe?g|gif|webp)$/i.test(att?.name || '');

// ---------- Slash command definition ----------
const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Configure verification bot for this server')
  .addSubcommand(sub =>
    sub
      .setName('verification')
      .setDescription('Set the verification channel')
      .addChannelOption(opt =>
        opt
          .setName('channel')
          .setDescription('Channel where users post verification screenshots and see the welcome message')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('staff')
      .setDescription('Set the staff review channel')
      .addChannelOption(opt =>
        opt
          .setName('channel')
          .setDescription('Channel where staff receive verification submissions')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('roles')
      .setDescription('Set legacy Role A / Role B / Not Verified role')
      .addRoleOption(opt =>
        opt
          .setName('role_a')
          .setDescription('Role for "Existing Server Member"')
          .setRequired(false)
      )
      .addRoleOption(opt =>
        opt
          .setName('role_b')
          .setDescription('Role for "Migrant"')
          .setRequired(false)
      )
      .addRoleOption(opt =>
        opt
          .setName('not_verified_role')
          .setDescription('Role for "Not Yet Verified" (removed on verify)')
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('modrole')
      .setDescription('Set the moderator role allowed to verify')
      .addRoleOption(opt =>
        opt
          .setName('role')
          .setDescription('Moderator / Migration Coordinator role')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('welcome')
      .setDescription('Set the welcome message for new members')
      .addStringOption(opt =>
        opt
          .setName('description')
          .setDescription('Message text (supports {user} and {verification_channel})')
          .setRequired(true)
      )
      .addStringOption(opt =>
        opt
          .setName('title')
          .setDescription('Embed title (only used in embed mode)')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt
          .setName('mode')
          .setDescription('How to send the welcome message')
          .addChoices(
            { name: 'Embed', value: 'embed' },
            { name: 'Normal message', value: 'text' }
          )
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('verifyrole_add')
      .setDescription('Add a verification role button (can assign multiple roles)')
      .addRoleOption(opt =>
        opt
          .setName('role_1')
          .setDescription('First role to assign (required)')
          .setRequired(true)
      )
      .addRoleOption(opt =>
        opt
          .setName('role_2')
          .setDescription('Second role to assign (optional)')
          .setRequired(false)
      )
      .addRoleOption(opt =>
        opt
          .setName('role_3')
          .setDescription('Third role to assign (optional)')
          .setRequired(false)
      )
      .addStringOption(opt =>
        opt
          .setName('label')
          .setDescription('Button label (e.g. "✅ Verify: Migrant + Extra")')
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('verifyrole_clear')
      .setDescription('Clear all verification role buttons')
  )
  .addSubcommand(sub =>
    sub
      .setName('verifyrole_list')
      .setDescription('List current verification role buttons')
  );

// ---------- Ready ----------
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 1) Clear ALL GLOBAL commands for this application (old leftovers)
  try {
    await client.application.commands.set([]);
    console.log('🧹 Cleared ALL global application commands.');
  } catch (err) {
    console.error('❌ Failed to clear global commands:', err);
  }

  // 2) Register /setup PER GUILD so it shows quickly and only once
  try {
    const guilds = await client.guilds.fetch();
    for (const [id] of guilds) {
      const guild = await client.guilds.fetch(id);
      await guild.commands.set([setupCommand]);
      console.log(`📦 Registered /setup command for guild ${guild.name} (${guild.id})`);
    }
  } catch (err) {
    console.error('❌ Failed to register guild commands:', err);
  }

  console.log('✅ Setup complete. Use /setup in your server to configure the bot.');
});

// When the bot joins a new server, register /setup there too
client.on(Events.GuildCreate, async (guild) => {
  try {
    await guild.commands.set([setupCommand]);
    console.log(`🆕 Registered /setup command for NEW guild ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error(`❌ Failed to register /setup for new guild ${guild.id}:`, err);
  }
});

// ---------- Welcome message logic ----------
const welcomedJoinKey = new Map(); // key: `${guildId}:${userId}` -> joinedTimestamp
const welcomeKey = (member) => `${member.guild.id}:${member.id}`;

function applyWelcomeTemplate(text, member, config) {
  let out = text || '';
  out = out.replaceAll('{user}', `<@${member.id}>`);
  if (config?.verificationChannelId) {
    out = out.replaceAll('{verification_channel}', `<#${config.verificationChannelId}>`);
  }
  return out;
}

const buildWelcomeEmbed = (member, config) => {
  const defaultDescription =
    `Welcome <@${member.id}>!\n\n` +
    `If you are looking to migrate to us, thank you for choosing our Empire to be your new home!\n\n` +
    (config?.verificationChannelId
      ? `Please head over to <#${config.verificationChannelId}> and post a screenshot of your in-game governor ID screen so a **Migration Coordinator** can verify you and assign the relevant roles.\n\n`
      : `Please follow the server instructions to post your in-game governor ID screen so a **Migration Coordinator** can verify you and assign the relevant roles.\n\n`
    ) +
    `*Once verified you will be granted access to the remainder of the server.*`;

  const rawDesc = config?.welcomeDescription || defaultDescription;
  const desc = applyWelcomeTemplate(rawDesc, member, config);

  const title =
    config?.welcomeTitle ||
    '👋 Welcome to the Empire 4 Migration Server!';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(0x3498db)
    .setTimestamp();
};

async function maybePostWelcome(member) {
  try {
    const config = getGuildConfig(member.guild.id);
    if (!config?.verificationChannelId) {
      console.log(`ℹ️ No verificationChannelId set for guild ${member.guild.id}, skipping welcome.`);
      return;
    }

    const joinKey = member.joinedTimestamp;
    const mapKey = welcomeKey(member);
    if (welcomedJoinKey.get(mapKey) === joinKey) return; // already welcomed this join

    const channel = await member.guild.channels.fetch(config.verificationChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.log(`⚠️ Configured verification channel not found or not text-based in guild ${member.guild.id}`);
      return;
    }

    const canView = channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel);
    if (!canView) {
      console.log(`ℹ️ Member ${member.id} cannot see verification channel yet, skipping welcome for now.`);
      return;
    }

        const helpRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`help:${member.id}`)
        .setLabel('🆘 HELP')
        .setStyle(ButtonStyle.Danger)
    );

    const mode = config.welcomeMode || 'embed';

    if (mode === 'text') {
      // Plain message mode
      const defaultDescription =
        `Welcome <@${member.id}>!\n\n` +
        `If you are looking to migrate to us, thank you for choosing our Empire to be your new home!\n\n` +
        (config?.verificationChannelId
          ? `Please head over to <#${config.verificationChannelId}> and post a screenshot of your in-game governor ID screen so a **Migration Coordinator** can verify you and assign the relevant roles.\n\n`
          : `Please follow the server instructions to post your in-game governor ID screen so a **Migration Coordinator** can verify you and assign the relevant roles.\n\n`
        ) +
        `*Once verified you will be granted access to the remainder of the server.*`;

      const rawDesc = config?.welcomeDescription || defaultDescription;
      const desc = applyWelcomeTemplate(rawDesc, member, config);

      await channel.send({
        content: desc,
        components: [helpRow],
      });
    } else {
      // Default: embed mode
      await channel.send({
        embeds: [buildWelcomeEmbed(member, config)],
        components: [helpRow],
      });
    }

    console.log(`👋 Sent welcome embed for member ${member.id} in guild ${member.guild.id}`);
    welcomedJoinKey.set(mapKey, joinKey);
  } catch (err) {
    console.error('❌ maybePostWelcome error:', err);
  }
}

// On join: assign Not Yet Verified + delayed welcome check
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const config = getGuildConfig(member.guild.id);
    if (!config) {
      console.log(`ℹ️ Member joined guild ${member.guild.id}, but no config exists yet.`);
      return;
    }

    // Assign "Not Yet Verified" role immediately if configured
    if (config.notVerifiedRoleId) {
      const role = member.guild.roles.cache.get(config.notVerifiedRoleId);
      if (role) {
        member.roles.add(role, 'Auto-assign Not Yet Verified on join')
          .then(() => console.log(`🧩 Added Not Yet Verified role to ${member.id} in guild ${member.guild.id}`))
          .catch(err => console.error('❌ Failed to add Not Yet Verified role:', err));
      } else {
        console.log(`⚠️ notVerifiedRoleId is set but role not found in guild ${member.guild.id}`);
      }
    }

    console.log(`👤 Member joined: ${member.id} in guild ${member.guild.id} – scheduling welcome.`);
    setTimeout(() => maybePostWelcome(member), 30_000);
  } catch (err) {
    console.error('❌ GuildMemberAdd welcome error:', err);
  }
});

// When screening completes
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const config = getGuildConfig(newMember.guild.id);
    if (!config) return;

    const wasPending = oldMember?.pending === true;
    const nowPending = newMember?.pending === true;

    if (wasPending && !nowPending) {
      console.log(`✅ Member ${newMember.id} finished screening in guild ${newMember.guild.id}, trying welcome.`);
      await maybePostWelcome(newMember);
    }
  } catch (err) {
    console.error('❌ GuildMemberUpdate welcome error:', err);
  }
});

// When member leaves: clear welcome cache for that guild+user
client.on(Events.GuildMemberRemove, (member) => {
  const key = welcomeKey(member);
  if (welcomedJoinKey.has(key)) {
    welcomedJoinKey.delete(key);
    console.log(`🧹 Cleared welcome cache for ${member.id} in guild ${member.guild.id} (member left).`);
  }
});

// ---------- Verification roles helper ----------
function getVerifyRoles(config, guild) {
  // Prefer flexible verifyRoles if present
  if (Array.isArray(config?.verifyRoles) && config.verifyRoles.length > 0) {
    return config.verifyRoles.map(vr => {
      if (Array.isArray(vr.roleIds) && vr.roleIds.length > 0) {
        return { roleIds: vr.roleIds, label: vr.label };
      }
      if (vr.roleId) {
        // Backwards compat for older single-role entries
        return { roleIds: [vr.roleId], label: vr.label };
      }
      return vr;
    });
  }

  // Fallback to legacy Role A / Role B
  const roles = [];
  if (config?.roleAId) {
    const r = guild.roles.cache.get(config.roleAId);
    roles.push({
      roleIds: [config.roleAId],
      label: r ? `✅ Verify: ${r.name}` : '✅ Verify: Role A',
    });
  }
  if (config?.roleBId) {
    const r = guild.roles.cache.get(config.roleBId);
    roles.push({
      roleIds: [config.roleBId],
      label: r ? `✅ Verify: ${r.name}` : '✅ Verify: Role B',
    });
  }
  return roles;
}

// ---------- Message listener: verification submissions ----------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author.bot) return;

    const config = getGuildConfig(message.guild.id);
    if (!config?.verificationChannelId || !config?.staffChannelId) return;
    if (message.channel.id !== config.verificationChannelId) return;

    const attachments = [...message.attachments.values()];
    const hasImage = attachments.some(isImageAttachment);
    if (!hasImage) return;

    console.log(`📸 Detected verification image from ${message.author.id} in guild ${message.guild.id}`);

    const staffChannel = await client.channels.fetch(config.staffChannelId).catch(() => null);
    if (!staffChannel || staffChannel.type !== ChannelType.GuildText) {
      console.log(`⚠️ Staff channel not found or not text-based in guild ${message.guild.id}`);
      return;
    }

    const author = message.author;
    const embed = new EmbedBuilder()
      .setTitle('New verification submission')
      .setDescription(
        `**User:** <@${author.id}>\n` +
        `**Message:** [jump to message](${message.url})\n\n` +
        (config.modRoleId
          ? `<@&${config.modRoleId}> please review the image and select which role set to assign, or deny.`
          : `Please review the image and select which role set to assign, or deny.`
        )
      )
      .setTimestamp(new Date())
      .setFooter({ text: `In #${message.channel.name}` });

    const firstImage = attachments.find(isImageAttachment);
    if (firstImage?.url) embed.setImage(firstImage.url);

    const verifyRoles = getVerifyRoles(config, message.guild);
    const allButtons = [];

    verifyRoles.forEach((vr, index) => {
      allButtons.push(
        new ButtonBuilder()
          .setCustomId(`assignset:${index}:${message.id}:${author.id}`)
          .setLabel(vr.label || '✅ Verify')
          .setStyle(ButtonStyle.Success)
      );
    });

    allButtons.push(
      new ButtonBuilder()
        .setCustomId(`deny:${message.id}:${author.id}`)
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger)
    );

    const rows = [];
    for (let i = 0; i < allButtons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(...allButtons.slice(i, i + 5)));
    }

    await staffChannel.send({
      embeds: [embed],
      components: rows,
      allowedMentions: { roles: config.modRoleId ? [config.modRoleId] : [] }
    });

    console.log(`📨 Sent staff verification embed for user ${author.id} in guild ${message.guild.id}`);
  } catch (err) {
    console.error('❌ Error handling verification submission:', err);
  }
});

// ---------- Interaction handling ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ----- Slash commands (/setup ...) -----
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'setup') return;
      if (!interaction.guildId || !interaction.guild) {
        return interaction.reply({
          content: 'This command can only be used in a server.',
          ephemeral: true,
        });
      }

      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need the **Manage Server** permission to run setup commands.',
          ephemeral: true,
        });
      }

      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const config = getGuildConfig(guildId) || {};
      console.log(`⚙️ /setup ${sub} used in guild ${guildId} by ${interaction.user.id}`);

      if (sub === 'verification') {
        const channel = interaction.options.getChannel('channel', true);
        updateGuildConfig(guildId, { verificationChannelId: channel.id });
        return interaction.reply({
          content: `✅ Verification channel set to <#${channel.id}>.`,
          ephemeral: true,
        });
      }

      if (sub === 'staff') {
        const channel = interaction.options.getChannel('channel', true);
        updateGuildConfig(guildId, { staffChannelId: channel.id });
        return interaction.reply({
          content: `✅ Staff review channel set to <#${channel.id}>.`,
          ephemeral: true,
        });
      }

      if (sub === 'roles') {
        const roleA = interaction.options.getRole('role_a', false);
        const roleB = interaction.options.getRole('role_b', false);
        const notVerified = interaction.options.getRole('not_verified_role', false);

        updateGuildConfig(guildId, {
          roleAId: roleA?.id ?? config.roleAId,
          roleBId: roleB?.id ?? config.roleBId,
          notVerifiedRoleId: notVerified?.id ?? config.notVerifiedRoleId,
        });

        const lines = [];
        lines.push('✅ Roles updated:');
        lines.push(
          `• Role A (Existing Server Member): ${
            roleA
              ? `<@&${roleA.id}>`
              : config.roleAId
              ? `<@&${config.roleAId}>`
              : '*(none set)*'
          }`,
        );
        lines.push(
          `• Role B (Migrant): ${
            roleB
              ? `<@&${roleB.id}>`
              : config.roleBId
              ? `<@&${config.roleBId}>`
              : '*(none set)*'
          }`,
        );
        lines.push(
          `• Not Yet Verified: ${
            notVerified
              ? `<@&${notVerified.id}>`
              : config.notVerifiedRoleId
              ? `<@&${config.notVerifiedRoleId}>`
              : '*(none set)*'
          }`,
        );

        return interaction.reply({
          content: lines.join('\n'),
          ephemeral: true,
        });
      }

      if (sub === 'modrole') {
        const role = interaction.options.getRole('role', true);
        updateGuildConfig(guildId, { modRoleId: role.id });
        return interaction.reply({
          content: `✅ Moderator / Migration Coordinator role set to <@&${role.id}>.`,
          ephemeral: true,
        });
      }

      if (sub === 'welcome') {
        const description = interaction.options.getString('description', true);
        const title = interaction.options.getString('title', false) || null;
        const mode = interaction.options.getString('mode', false) || null; // 'embed' | 'text' | null

        updateGuildConfig(guildId, {
          welcomeTitle: title || undefined,
          welcomeDescription: description,
          welcomeMode: mode || config.welcomeMode || 'embed',
        });

        return interaction.reply({
          content:
            '✅ Welcome message updated.\n' +
            'You can use these placeholders in the description:\n' +
            '• `{user}` → mentions the new member\n' +
            '• `{verification_channel}` → mentions the configured verification channel\n\n' +
            `Current mode: \`${mode || config.welcomeMode || 'embed'}\``,
          ephemeral: true,
        });
      }

      if (sub === 'verifyrole_add') {
        const role1 = interaction.options.getRole('role_1', true);
        const role2 = interaction.options.getRole('role_2', false);
        const role3 = interaction.options.getRole('role_3', false);
        const label =
          interaction.options.getString('label', false) || `✅ Verify: ${role1.name}`;

        const roles = [role1, role2, role3].filter(Boolean);
        const roleIds = roles.map((r) => r.id);

        const me = interaction.guild.members.me;
        const issues = [];

        // Bot permission check
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          issues.push('• Bot is missing the **Manage Roles** permission.');
        }

        // Role-specific checks
        for (const r of roles) {
          if (r.managed) {
            issues.push(
              `• <@&${r.id}> is a **managed role** (integration / booster) and cannot be assigned by bots.`,
            );
          }
          if (r.position >= me.roles.highest.position) {
            issues.push(
              `• <@&${r.id}> is **above or equal to the bot's highest role**. Move the bot role above it in Server Settings → Roles.`,
            );
          }
        }

        if (issues.length > 0) {
          return interaction.reply({
            content:
              '⚠️ I can\'t reliably assign one or more of those roles yet:\n' +
              issues.join('\n') +
              '\n\nPlease fix these, then run `/setup verifyrole_add` again.',
            ephemeral: true,
          });
        }

        const existing = Array.isArray(config.verifyRoles) ? config.verifyRoles : [];

        if (
          existing.some(
            (vr) =>
              Array.isArray(vr.roleIds) &&
              vr.roleIds.length === roleIds.length &&
              vr.roleIds.every((id) => roleIds.includes(id)),
          )
        ) {
          return interaction.reply({
            content: 'A button with exactly those roles already exists.',
            ephemeral: true,
          });
        }

        const updated = [...existing, { roleIds, label }];
        updateGuildConfig(guildId, { verifyRoles: updated });

        const roleMentions = roleIds.map((id) => `<@&${id}>`).join(', ');

        return interaction.reply({
          content:
            `✅ Added verification role button:\n` +
            `• Roles: ${roleMentions}\n` +
            `• Label: \`${label}\`\n\n` +
            `Bot highest role: <@&${me.roles.highest.id}> (position ${me.roles.highest.position})`,
          ephemeral: true,
        });
      }

      if (sub === 'verifyrole_clear') {
        updateGuildConfig(guildId, { verifyRoles: [] });
        return interaction.reply({
          content: '✅ Cleared all verification role buttons.',
          ephemeral: true,
        });
      }

      if (sub === 'verifyrole_list') {
        const list = Array.isArray(config.verifyRoles) ? config.verifyRoles : [];
        if (list.length === 0) {
          return interaction.reply({
            content:
              'There are currently **no** custom verification role buttons.\n' +
              'You can add one with `/setup verifyrole_add`.\n\n' +
              'If you have `role_a` / `role_b` set via `/setup roles`, those will still be used as fallback.',
            ephemeral: true,
          });
        }

        const lines = list.map((vr, idx) => {
          const roleIds = vr.roleIds || (vr.roleId ? [vr.roleId] : []);
          const rolesText = roleIds.length
            ? roleIds.map((id) => `<@&${id}>`).join(', ')
            : '*(no roles set)*';
          return `${idx + 1}. ${rolesText} — label: \`${vr.label}\``;
        });

        return interaction.reply({
          content: 'Current verification role buttons:\n' + lines.join('\n'),
          ephemeral: true,
        });
      }

      // end of /setup handling
      return;
    }

    // ----- Button interactions -----
    if (!interaction.isButton()) return;

    const guild = interaction.guild;
    if (!guild) return;

    const config = getGuildConfig(guild.id);
    if (!config) return;

    // HELP button from welcome message
    if (interaction.customId.startsWith('help:')) {
      const userId = interaction.customId.split(':')[1];
      const staffChannelId = config.staffChannelId;

      if (staffChannelId) {
        const staffChannel = await client.channels
          .fetch(staffChannelId)
          .catch(() => null);

        if (staffChannel && staffChannel.isTextBased()) {
          const content = config.modRoleId
            ? `<@&${config.modRoleId}> **User <@${userId}> needs help with verification.**`
            : `**User <@${userId}> needs help with verification.**`;

          await staffChannel.send({
            content,
            allowedMentions: {
              roles: config.modRoleId ? [config.modRoleId] : [],
              users: [userId],
            },
          });
        }
      }

      return interaction.reply({
        content: '✅ A moderator has been notified — someone will assist you shortly!',
        ephemeral: true,
      });
    }

    // Restrict verification actions (buttons) to modRole or ManageRoles
    if (config.modRoleId) {
      const member = await guild.members.fetch(interaction.user.id);
      if (
        !member.roles.cache.has(config.modRoleId) &&
        !member.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return interaction.reply({
          content: 'You are not allowed to do that.',
          ephemeral: true,
        });
      }
    }

    const parts = interaction.customId.split(':');
    const action = parts[0];

    let messageId;
    let targetUserId;
    let targetMember;
    let roleIdsToAssign = [];

    if (action === 'assignset') {
      // assignset:<index>:<messageId>:<userId>
      const setIndex = Number(parts[1]);
      messageId = parts[2];
      targetUserId = parts[3];

      const verifyRoles = getVerifyRoles(config, guild);
      const vr = verifyRoles[setIndex];
      if (!vr || !Array.isArray(vr.roleIds) || vr.roleIds.length === 0) {
        return interaction.reply({
          content: 'This verification button is not configured with any roles.',
          ephemeral: true,
        });
      }

      targetMember = await guild.members.fetch(targetUserId).catch(() => null);
      if (!targetMember) {
        return interaction.reply({
          content: 'User is no longer in the server.',
          ephemeral: true,
        });
      }

      roleIdsToAssign = vr.roleIds;
    } else if (action === 'deny') {
      messageId = parts[1];
      targetUserId = parts[2];

      targetMember = await guild.members.fetch(targetUserId).catch(() => null);
      if (!targetMember) {
        return interaction.reply({
          content: 'User is no longer in the server.',
          ephemeral: true,
        });
      }
    } else {
      return;
    }

    const notVerifiedRole = config.notVerifiedRoleId
      ? guild.roles.cache.get(config.notVerifiedRoleId)
      : null;

    const removeNotVerifiedIfAny = async () => {
      if (notVerifiedRole && targetMember.roles.cache.has(notVerifiedRole.id)) {
        await targetMember.roles
          .remove(
            notVerifiedRole,
            `Auto-removed on verification by ${interaction.user.tag}`,
          )
          .catch(() => {});
      }
    };

    const finishAndAck = async (content) =>
      interaction.update({
        components: [],
        embeds: [interaction.message.embeds[0].toJSON()],
        content,
      });

    if (action === 'assignset') {
      const rolesToAdd = roleIdsToAssign
        .map((id) => guild.roles.cache.get(id))
        .filter(Boolean);

      if (rolesToAdd.length === 0) {
        return interaction.reply({
          content:
            'None of the configured roles for this button exist on this server anymore.',
          ephemeral: true,
        });
      }

      const me = guild.members.me;
      const issues = [];

      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        issues.push('• Bot is missing the **Manage Roles** permission.');
      }

      for (const r of rolesToAdd) {
        if (r.managed) {
          issues.push(
            `• <@&${r.id}> is a **managed role** and cannot be assigned by bots.`,
          );
        }
        if (r.position >= me.roles.highest.position) {
          issues.push(
            `• <@&${r.id}> is **above or equal to the bot's highest role**. Move the bot role above it in Server Settings → Roles.`,
          );
        }
      }

      if (issues.length > 0) {
        return interaction.reply({
          content:
            '⚠️ I tried to assign those roles but ran into problems:\n' +
            issues.join('\n') +
            `\n\nBot highest role: <@&${me.roles.highest.id}> (position ${me.roles.highest.position})`,
          ephemeral: true,
        });
      }

      await targetMember.roles.add(rolesToAdd, `Verified by ${interaction.user.tag}`);
      await removeNotVerifiedIfAny();

      const rolesMentionText = rolesToAdd.map((r) => `<@&${r.id}>`).join(', ');

      await finishAndAck(
        `✅ Assigned ${rolesMentionText} to <@${targetUserId}> (by <@${interaction.user.id}>)`,
      );
      targetMember
        .send(
          `You’ve been verified in **${guild.name}** and given the roles ${rolesToAdd
            .map((r) => `**${r.name}**`)
            .join(', ')}. Welcome!`,
        )
        .catch(() => {});
      return;
    }

    if (action === 'deny') {
      if (config.verificationChannelId) {
        const verificationChannel = await interaction.client.channels
          .fetch(config.verificationChannelId)
          .catch(() => null);
        if (verificationChannel?.isTextBased()) {
          const original = await verificationChannel.messages
            .fetch(messageId)
            .catch(() => null);
          if (original) await original.delete().catch(() => null);
        }
      }
      await finishAndAck(
        `❌ Denied <@${targetUserId}> (by <@${interaction.user.id}>)`,
      );
      targetMember
        .send(
          `Your verification in **${guild.name}** was not approved. Please review the instructions and try again.`,
        )
        .catch(() => {});
      return;
    }
  } catch (err) {
    console.error('❌ Error handling interaction:', err);
    if (interaction.isRepliable()) {
      interaction
        .reply({
          content: `Something went wrong while processing that action:\n\`${
            err.message || err
          }\``,
          ephemeral: true,
        })
        .catch(() => {});
    }
  }
});

// ---------- Login ----------
client.login(DISCORD_TOKEN);