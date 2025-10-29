// index.js
import 'dotenv/config';
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
} from 'discord.js';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  VERIFICATION_CHANNEL_ID,
  STAFF_CHANNEL_ID,
  ROLE_A_ID, // Verify: Existing Server Member
  ROLE_B_ID, // Verify: Migrant
  NOT_VERIFIED_ROLE_ID, // Not Yet Verified (to be removed on verify)
  MOD_ROLE_ID, // optional (restrict who can click)
} = process.env;

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

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

/* ---------- Welcome message logic (embed + HELP button + rejoin fix) ---------- */
const welcomedJoinKey = new Map();

const buildWelcomeEmbed = (member) =>
  new EmbedBuilder()
    .setTitle('👋 Welcome to the Empire 4 Migration Server!')
    .setDescription(
      `Welcome <@${member.id}>!\n\n` +
      `If you are looking to migrate to us, thank you for choosing our Empire to be your new home!\n\n` +
      `Please head over to <#${VERIFICATION_CHANNEL_ID}> and post a screenshot of your in-game governor ID screen so a **Migration Coordinator** can verify you and assign the relevant roles.\n\n` +
      `*Once verified you will be granted access to the remainder of the server.*`
    )
    .setColor(0x3498db)
    .setTimestamp();

async function maybePostWelcome(member) {
  try {
    if (member.guild.id !== GUILD_ID) return;

    const joinKey = member.joinedTimestamp;
    if (welcomedJoinKey.get(member.id) === joinKey) return; // already welcomed this join

    const channel = await member.guild.channels.fetch(VERIFICATION_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    // Only post if the member can actually view the channel
    const canView = channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel);
    if (!canView) return;

    // HELP button
    const helpRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`help:${member.id}`)
        .setLabel('🆘 HELP')
        .setStyle(ButtonStyle.Danger)
    );

    await channel.send({
      embeds: [buildWelcomeEmbed(member)],
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
    if (member.guild.id !== GUILD_ID) return;
    setTimeout(() => maybePostWelcome(member), 30_000);
  } catch (err) {
    console.error('GuildMemberAdd welcome error:', err);
  }
});

// When screening completes (pending -> false), try to post
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    if (newMember.guild.id !== GUILD_ID) return;

    const wasPending = oldMember?.pending === true;
    const nowPending = newMember?.pending === true;

    if (wasPending && !nowPending) {
      await maybePostWelcome(newMember);
    }
  } catch (err) {
    console.error('GuildMemberUpdate welcome error:', err);
  }
});
/* ------------------------------------------------------------------------------ */

/* -------------------- Listen for images and staff prompt ---------------------- */
client.on(Events.MessageCreate, async (message) => {
  try {
    if (
      message.guild?.id !== GUILD_ID ||
      message.channel.id !== VERIFICATION_CHANNEL_ID ||
      message.author.bot
    ) return;

    const attachments = [...message.attachments.values()];
    const hasImage = attachments.some(isImageAttachment);
    if (!hasImage) return;

    const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID);
    if (!staffChannel || staffChannel.type !== ChannelType.GuildText) return;

    const author = message.author;
    const embed = new EmbedBuilder()
      .setTitle('New verification submission')
      .setDescription(
        `**User:** <@${author.id}>\n` +
        `**Message:** [jump to message](${message.url})\n\n` +
        (MOD_ROLE_ID
          ? `<@&${MOD_ROLE_ID}> please review the image and select which role to assign, or deny.`
          : `Please review the image and select which role to assign, or deny.`)
      )
      .setTimestamp(new Date())
      .setFooter({ text: `In #${message.channel.name}` });

    const firstImage = attachments.find(isImageAttachment);
    if (firstImage?.url) embed.setImage(firstImage.url);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`assignA:${message.id}:${author.id}`)
        .setLabel('✅ Verify: Existing Server Member')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`assignB:${message.id}:${author.id}`)
        .setLabel('✅ Verify: Migrant')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`deny:${message.id}:${author.id}`)
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger),
    );

    await staffChannel.send({
      embeds: [embed],
      components: [row],
      allowedMentions: { roles: MOD_ROLE_ID ? [MOD_ROLE_ID] : [] }
    });
  } catch (err) {
    console.error('Error handling verification submission:', err);
  }
});
/* ------------------------------------------------------------------------------ */

/* ---------------------------- Button handling --------------------------------- */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    /* ----- HELP button ----- */
    if (interaction.customId.startsWith('help:')) {
      const userId = interaction.customId.split(':')[1];
      const staffChannel = await client.channels.fetch(STAFF_CHANNEL_ID).catch(() => null);

      if (staffChannel && staffChannel.isTextBased()) {
        const content = MOD_ROLE_ID
          ? `<@&${MOD_ROLE_ID}> **User <@${userId}> needs help with verification.**`
          : `**User <@${userId}> needs help with verification.**`;

        await staffChannel.send({
          content,
          allowedMentions: {
            roles: MOD_ROLE_ID ? [MOD_ROLE_ID] : [],
            users: [userId],
          },
        });
      }

      return interaction.reply({
        content: '✅ A moderator has been notified — someone will assist you shortly!',
        ephemeral: true,
      });
    }
    /* ------------------------------------------------ */

    // Restrict verification actions to mods/managers
    if (MOD_ROLE_ID) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (
        !member.roles.cache.has(MOD_ROLE_ID) &&
        !member.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return interaction.reply({
          content: 'You are not allowed to do that.',
          ephemeral: true,
        });
      }
    }

    // Handle verification buttons (assignA/assignB/deny)
    const [action, messageId, targetUserId] = interaction.customId.split(':');
    const guild = interaction.guild;
    if (!guild) {
      return interaction.reply({ content: 'Guild not found.', ephemeral: true });
    }

    const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) {
      return interaction.reply({
        content: 'User is no longer in the server.',
        ephemeral: true,
      });
    }

    const roleA = guild.roles.cache.get(ROLE_A_ID);
    const roleB = guild.roles.cache.get(ROLE_B_ID);
    const notVerifiedRole = NOT_VERIFIED_ROLE_ID
      ? guild.roles.cache.get(NOT_VERIFIED_ROLE_ID)
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

    if (action === 'assignA') {
      if (!roleA)
        return interaction.reply({ content: 'Role A not found.', ephemeral: true });

      await targetMember.roles.add(roleA, `Verified by ${interaction.user.tag} (Role A)`);
      await removeNotVerifiedIfAny();

      await finishAndAck(
        `✅ Assigned <@&${ROLE_A_ID}> to <@${targetUserId}> (by <@${interaction.user.id}>)`
      );
      targetMember.send(
        `You’ve been verified in **${guild.name}** and given the role **${roleA.name}**. Welcome!`
      ).catch(() => {});
    } else if (action === 'assignB') {
      if (!roleB)
        return interaction.reply({ content: 'Role B not found.', ephemeral: true });

      await targetMember.roles.add(roleB, `Verified by ${interaction.user.tag} (Role B)`);
      await removeNotVerifiedIfAny();

      await finishAndAck(
        `✅ Assigned <@&${ROLE_B_ID}> to <@${targetUserId}> (by <@${interaction.user.id}>)`
      );
      targetMember.send(
        `You’ve been verified in **${guild.name}** and given the role **${roleB.name}**. Welcome! Please head over to <#1422618567458951368> next and fill out a form.`
      ).catch(() => {});
    } else if (action === 'deny') {
      const verificationChannel = await interaction.client.channels
        .fetch(VERIFICATION_CHANNEL_ID)
        .catch(() => null);
      if (verificationChannel?.isTextBased()) {
        const original = await verificationChannel.messages
          .fetch(messageId)
          .catch(() => null);
        if (original) await original.delete().catch(() => null);
      }
      await finishAndAck(
        `❌ Denied <@${targetUserId}> (by <@${interaction.user.id}>)`
      );
      targetMember.send(
        `Your verification in **${guild.name}** was not approved. Please review the instructions and try again.`
      ).catch(() => {});
    }
  } catch (err) {
    console.error('Error handling button interaction:', err);
    if (interaction.isRepliable()) {
      interaction.reply({
        content: 'Something went wrong while processing that action.',
        ephemeral: true,
      }).catch(() => {});
    }
  }
});
/* ------------------------------------------------------------------------------ */

client.login(DISCORD_TOKEN);