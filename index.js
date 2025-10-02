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

// Listen for images in #verification and send staff prompt
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
      .setTitle('<@&${MOD_ROLE_ID}> New verification submission')
      .setDescription(
        `**User:** <@${author.id}> (${author.id})\n` +
        `**Message:** [jump to message](${message.url})\n\n` +
        'Review the image and select which role to assign, or deny.'
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

    await staffChannel.send({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Error handling verification submission:', err);
  }
});

// Handle button clicks
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    // Optional restriction: only mods (or anyone with Manage Roles)
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

    // helper: remove Not Yet Verified if present
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

client.login(DISCORD_TOKEN);