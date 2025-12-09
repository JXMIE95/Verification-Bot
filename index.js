// index.js
import 'dotenv/config';
import fs from 'fs';
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

// ---------- Persistent per-guild settings (JSON file) ----------
const SETTINGS_PATH = './guildSettings.json';

/**
 * guildSettings structure:
 * {
 *   [guildId]: {
 *     verificationChannelId?: string,
 *     staffChannelId?: string,
 *     roleAId?: string,              // legacy simple A/B roles
 *     roleBId?: string,
 *     notVerifiedRoleId?: string,
 *     modRoleId?: string,
 *     verifyRoles?: [                // flexible role buttons
 *       { roleId: string, label: string }
 *     ],
 *     welcomeTitle?: string,
 *     welcomeDescription?: string
 *   }
 * }
 */
let guildSettings = {};
if (fs.existsSync(SETTINGS_PATH)) {
  try {
    guildSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to parse guildSettings.json, starting empty:', e);
    guildSettings = {};
  }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(guildSettings, null, 2));
}

function getGuildConfig(guildId) {
  return guildSettings[guildId];
}

function updateGuildConfig(guildId, partial) {
  const existing = guildSettings[guildId] || {};
  guildSettings[guildId] = { ...existing, ...partial };
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

// ---------- Slash command registration ----------
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

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
        .setDescription('Set the welcome embed text for new members')
        .addStringOption(opt =>
          opt
            .setName('description')
            .setDescription('Embed description (supports {user} and {verification_channel})')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('title')
            .setDescription('Embed title (optional)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('verifyrole_add')
        .setDescription('Add a verification role button')
        .addRoleOption(opt =>
          opt
            .setName('role')
            .setDescription('Role to assign')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('label')
            .setDescription('Button label (e.g. "✅ Verify: Migrant")')
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

  await client.application.commands.set([setupCommand]);
  console.log('✅ Slash commands registered');
});

// ---------- Welcome message logic (embed + HELP, per-guild) ----------
const welcomedJoinKey = new Map(); // userId -> joinedTimestamp

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
    if (!config?.verificationChannelId) return;

    const joinKey = member.joinedTimestamp;
    if (welcomedJoinKey.get(member.id) === joinKey) return; // already welcomed this join

    const channel = await member.guild.channels.fetch(config.verificationChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    // Only post if the member can actually view the channel
    const canView = channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel);
    if (!canView) return;

    const helpRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`help:${member.id}`)
        .setLabel('🆘 HELP')
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      embeds: [buildWelcomeEmbed(member, config)],
      components: [helpRow],
    });

    welcomedJoinKey.set(member.id, joinKey);
  } catch (err) {
    console.error('maybePostWelcome error:', err);
  }
}

// On join: delayed check (in case screening completes fast)
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const config = getGuildConfig(member.guild.id);
    if (!config) return; // bot not set up for this guild
    setTimeout(() => maybePostWelcome(member), 30_000);
  } catch (err) {
    console.error('GuildMemberAdd welcome error:', err);
  }
});

// When screening completes (pending -> false), try to post
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const config = getGuildConfig(newMember.guild.id);
    if (!config) return;

    const wasPending = oldMember?.pending === true;
    const nowPending = newMember?.pending === true;

    if (wasPending && !nowPending) {
      await maybePostWelcome(newMember);
    }
  } catch (err) {
    console.error('GuildMemberUpdate welcome error:', err);
  }
});

// ---------- Build verification role buttons (flexible) ----------
function getVerifyRoles(config, guild) {
  // If flexible roles configured, use those
  if (Array.isArray(config?.verifyRoles) && config.verifyRoles.length > 0) {
    return config.verifyRoles;
  }

  // Fallback to legacy Role A / Role B if present
  const roles = [];
  if (config?.roleAId) {
    const r = guild.roles.cache.get(config.roleAId);
    roles.push({
      roleId: config.roleAId,
      label: r ? `✅ Verify: ${r.name}` : '✅ Verify: Role A',
    });
  }
  if (config?.roleBId) {
    const r = guild.roles.cache.get(config.roleBId);
    roles.push({
      roleId: config.roleBId,
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

    const staffChannel = await client.channels.fetch(config.staffChannelId).catch(() => null);
    if (!staffChannel || staffChannel.type !== ChannelType.GuildText) return;

    const author = message.author;
    const embed = new EmbedBuilder()
      .setTitle('New verification submission')
      .setDescription(
        `**User:** <@${author.id}>\n` +
        `**Message:** [jump to message](${message.url})\n\n` +
        (config.modRoleId
          ? `<@&${config.modRoleId}> please review the image and select which role to assign, or deny.`
          : `Please review the image and select which role to assign, or deny.`
        )
      )
      .setTimestamp(new Date())
      .setFooter({ text: `In #${message.channel.name}` });

    const firstImage = attachments.find(isImageAttachment);
    if (firstImage?.url) embed.setImage(firstImage.url);

    const verifyRoles = getVerifyRoles(config, message.guild);

    const allButtons = [];

    // Dynamic role buttons
    for (const vr of verifyRoles) {
      allButtons.push(
        new ButtonBuilder()
          .setCustomId(`assign:${vr.roleId}:${message.id}:${author.id}`)
          .setLabel(vr.label || '✅ Verify')
          .setStyle(ButtonStyle.Success)
      );
    }

    // Deny button
    allButtons.push(
      new ButtonBuilder()
        .setCustomId(`deny:${message.id}:${author.id}`)
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger)
    );

    // Chunk into rows of up to 5 buttons
    const rows = [];
    for (let i = 0; i < allButtons.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(...allButtons.slice(i, i + 5)));
    }

    await staffChannel.send({
      embeds: [embed],
      components: rows,
      allowedMentions: { roles: config.modRoleId ? [config.modRoleId] : [] }
    });
  } catch (err) {
    console.error('Error handling verification submission:', err);
  }
});

// ---------- Interaction handling: slash commands + buttons ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // ----- Slash commands (/setup ...) -----
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== 'setup') return;
      if (!interaction.guildId || !interaction.guild) {
        return interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      }

      // Only allow admins / manage guild to run setup
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'You need the **Manage Server** permission to run setup commands.',
          ephemeral: true,
        });
      }

      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const config = getGuildConfig(guildId) || {};

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
          roleAId: roleA?.id || config.roleAId,
          roleBId: roleB?.id || config.roleBId,
          notVerifiedRoleId: notVerified?.id || config.notVerifiedRoleId,
        });

        const lines = [];
        lines.push('✅ Roles updated:');
        lines.push(`• Role A (Existing Server Member): ${roleA ? `<@&${roleA.id}>` : (config.roleAId ? `<@&${config.roleAId}>` : '*(none set)*')}`);
        lines.push(`• Role B (Migrant): ${roleB ? `<@&${roleB.id}>` : (config.roleBId ? `<@&${config.roleBId}>` : '*(none set)*')}`);
        lines.push(`• Not Yet Verified: ${notVerified ? `<@&${notVerified.id}>` : (config.notVerifiedRoleId ? `<@&${config.notVerifiedRoleId}>` : '*(none set)*')}`);

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

        updateGuildConfig(guildId, {
          welcomeTitle: title || undefined,
          welcomeDescription: description,
        });

        return interaction.reply({
          content:
            '✅ Welcome embed updated.\n' +
            'You can use these placeholders in the description:\n' +
            '• `{user}` → mentions the new member\n' +
            '• `{verification_channel}` → mentions the configured verification channel',
          ephemeral: true,
        });
      }

      if (sub === 'verifyrole_add') {
        const role = interaction.options.getRole('role', true);
        const label = interaction.options.getString('label', false) || `✅ Verify: ${role.name}`;

        const existing = Array.isArray(config.verifyRoles) ? config.verifyRoles : [];
        if (existing.some(vr => vr.roleId === role.id)) {
          return interaction.reply({
            content: `That role is already configured as a verification button.`,
            ephemeral: true,
          });
        }

        const updated = [...existing, { roleId: role.id, label }];
        updateGuildConfig(guildId, { verifyRoles: updated });

        return interaction.reply({
          content: `✅ Added verification role button:\n• Role: <@&${role.id}>\n• Label: \`${label}\``,
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

        const lines = list.map(
          (vr, idx) => `${idx + 1}. <@&${vr.roleId}> — label: \`${vr.label}\``
        );

        return interaction.reply({
          content:
            'Current verification role buttons:\n' +
            lines.join('\n'),
          ephemeral: true,
        });
      }

      return;
    }

    // ----- Button interactions -----
    if (!interaction.isButton()) return;

    const guild = interaction.guild;
    if (!guild) return;

    const config = getGuildConfig(guild.id);
    if (!config) return;

    // HELP button (ping staff)
    if (interaction.customId.startsWith('help:')) {
      const userId = interaction.customId.split(':')[1];
      const staffChannelId = config.staffChannelId;
      if (staffChannelId) {
        const staffChannel = await client.channels.fetch(staffChannelId).catch(() => null);

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

    // From here: verification buttons (assign / legacy assignA/B / deny)

    // Restrict verification actions to mods/managers if modRoleId is set
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

    // Common values for all patterns
    let messageId;
    let targetUserId;
    let targetMember;
    let assignedRole = null;

    if (action === 'assign') {
      // New format: assign:<roleId>:<messageId>:<userId>
      const roleId = parts[1];
      messageId = parts[2];
      targetUserId = parts[3];

      targetMember = await guild.members.fetch(targetUserId).catch(() => null);
      if (!targetMember) {
        return interaction.reply({
          content: 'User is no longer in the server.',
          ephemeral: true,
        });
      }

      assignedRole = guild.roles.cache.get(roleId);
      if (!assignedRole) {
        return interaction.reply({
          content: 'That role no longer exists on this server.',
          ephemeral: true,
        });
      }

    } else if (action === 'assignA' || action === 'assignB' || action === 'deny') {
      // Legacy format: assignA:<messageId>:<userId> / assignB:<messageId>:<userId> / deny:<messageId>:<userId>
      messageId = parts[1];
      targetUserId = parts[2];

      targetMember = await guild.members.fetch(targetUserId).catch(() => null);
      if (!targetMember) {
        return interaction.reply({
          content: 'User is no longer in the server.',
          ephemeral: true,
        });
      }

      if (action === 'assignA') {
        assignedRole = config.roleAId ? guild.roles.cache.get(config.roleAId) : null;
        if (!assignedRole) {
          return interaction.reply({
            content: 'Role A not set or not found.',
            ephemeral: true,
          });
        }
      } else if (action === 'assignB') {
        assignedRole = config.roleBId ? guild.roles.cache.get(config.roleBId) : null;
        if (!assignedRole) {
          return interaction.reply({
            content: 'Role B not set or not found.',
            ephemeral: true,
          });
        }
      }
    } else {
      // Unknown button
      return;
    }

    const notVerifiedRole = config.notVerifiedRoleId
      ? guild.roles.cache.get(config.notVerifiedRoleId)
      : null;

    const removeNotVerifiedIfAny = async () => {
      if (notVerifiedRole && targetMember.roles.cache.has(notVerifiedRole.id)) {
        await targetMember.roles.remove(
          notVerifiedRole,
          `Auto-removed on verification by ${interaction.user.tag}`
        ).catch(() => {});
      }
    };

    const finishAndAck = async (content) =>
      interaction.update({
        components: [],
        embeds: [interaction.message.embeds[0].toJSON()],
        content,
      });

    if (action === 'assign' || action === 'assignA' || action === 'assignB') {
      await targetMember.roles.add(
        assignedRole,
        `Verified by ${interaction.user.tag}`
      );
      await removeNotVerifiedIfAny();

      await finishAndAck(
        `✅ Assigned <@&${assignedRole.id}> to <@${targetUserId}> (by <@${interaction.user.id}>)`
      );
      targetMember.send(
        `You’ve been verified in **${guild.name}** and given the role **${assignedRole.name}**. Welcome!`
      ).catch(() => {});
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
        `❌ Denied <@${targetUserId}> (by <@${interaction.user.id}>)`
      );
      targetMember.send(
        `Your verification in **${guild.name}** was not approved. Please review the instructions and try again.`
      ).catch(() => {});
      return;
    }
  } catch (err) {
    console.error('Error handling interaction:', err);
    if (interaction.isRepliable()) {
      interaction.reply({
        content: 'Something went wrong while processing that action.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

// ---------- Login ----------
client.login(DISCORD_TOKEN);