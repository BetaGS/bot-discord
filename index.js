import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';

// ───────────────────────── Configuração (variáveis de ambiente) ─────────────────────────
const env = process.env;
const required = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'VIP_ROLE_ID',
  'INFINITE_HANDLE',
  'PUBLIC_URL',
  'WEBHOOK_SECRET',
];
for (const key of required) {
  if (!env[key]) {
    console.error(`Variável de ambiente ausente: ${key}`);
    process.exit(1);
  }
}

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  VIP_ROLE_ID,
  INFINITE_HANDLE,
  WEBHOOK_SECRET,
} = env;
const PUBLIC_URL = env.PUBLIC_URL.replace(/\/$/, '');
const PRICE_CENTS = parseInt(env.PRICE_CENTS ?? '100', 10);
const PRODUCT_NAME = env.PRODUCT_NAME ?? 'Assinatura VIP (1 ano)';
const PORT = parseInt(env.PORT ?? '3000', 10);
const DB_PATH = env.DB_PATH ?? './bot.db';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
// Modo de teste: se TEST_DURATION_MINUTES existir, a assinatura dura só alguns minutos.
const durationMs = env.TEST_DURATION_MINUTES
  ? Number(env.TEST_DURATION_MINUTES) * MINUTE
  : Number(env.SUBSCRIPTION_DAYS ?? 365) * DAY;
const reminderMs = env.TEST_REMINDER_MINUTES
  ? Number(env.TEST_REMINDER_MINUTES) * MINUTE
  : Number(env.REMINDER_DAYS ?? 30) * DAY;

const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (ms) =>
  new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

// ───────────────────────── Banco de dados (SQLite) ─────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    order_nsu TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    transaction_nsu TEXT
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    reminded INTEGER NOT NULL DEFAULT 0
  );
`);

const getOrder = db.prepare('SELECT * FROM orders WHERE order_nsu = ?');
const getSub = db.prepare('SELECT * FROM subscriptions WHERE user_id = ?');

// Marca o pedido como pago (uma única vez) e estende a assinatura.
const settleOrder = db.transaction((orderNsu, userId, transactionNsu) => {
  const upd = db
    .prepare(
      `UPDATE orders SET status = 'paid', paid_at = ?, transaction_nsu = ?
       WHERE order_nsu = ? AND status = 'pending'`
    )
    .run(Date.now(), transactionNsu ?? null, orderNsu);
  if (upd.changes !== 1) return null; // já processado (webhook repetido)

  const now = Date.now();
  const current = getSub.get(userId);
  const base =
    current && current.active && current.expires_at > now ? current.expires_at : now;
  const expiresAt = base + durationMs;
  db.prepare(
    `INSERT INTO subscriptions (user_id, expires_at, active, reminded)
     VALUES (?, ?, 1, 0)
     ON CONFLICT(user_id) DO UPDATE SET
       expires_at = excluded.expires_at, active = 1, reminded = 0`
  ).run(userId, expiresAt);
  return expiresAt;
});

// ───────────────────────── InfinitePay ─────────────────────────
const INFINITE_API = 'https://api.checkout.infinitepay.io';

async function createCheckoutLink(userId) {
  const orderNsu = randomUUID();
  db.prepare('INSERT INTO orders (order_nsu, user_id, created_at) VALUES (?, ?, ?)').run(
    orderNsu,
    userId,
    Date.now()
  );

  const res = await fetch(`${INFINITE_API}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: INFINITE_HANDLE,
      order_nsu: orderNsu,
      items: [{ quantity: 1, price: PRICE_CENTS, description: PRODUCT_NAME }],
      webhook_url: `${PUBLIC_URL}/webhook/infinitepay?token=${WEBHOOK_SECRET}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    console.error('Falha ao criar checkout:', res.status, JSON.stringify(data));
    throw new Error('checkout_failed');
  }
  return data.url;
}

// Confirma na InfinitePay que o pagamento realmente foi aprovado.
async function isPaid({ orderNsu, transactionNsu, slug }) {
  const res = await fetch(`${INFINITE_API}/payment_check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle: INFINITE_HANDLE,
      order_nsu: orderNsu,
      transaction_nsu: transactionNsu,
      slug,
    }),
  });
  const data = await res.json().catch(() => ({}));
  console.log('payment_check:', res.status, JSON.stringify(data));
  return res.ok && data.paid === true;
}

// ───────────────────────── Discord ─────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

async function fetchMember(userId) {
  const guild = await client.guilds.fetch(GUILD_ID);
  return guild.members.fetch(userId).catch(() => null);
}

async function grantRole(userId) {
  const member = await fetchMember(userId);
  if (!member) return null;
  await member.roles.add(VIP_ROLE_ID, 'Assinatura VIP paga');
  return member;
}

async function revokeRole(userId) {
  const member = await fetchMember(userId);
  if (!member) return null; // saiu do servidor: nada a remover
  await member.roles.remove(VIP_ROLE_ID, 'Assinatura VIP expirada');
  return member;
}

async function sendDM(member, text) {
  try {
    await member.send(text);
  } catch {
    /* DMs fechadas: ignora */
  }
}

async function handleSubscribe(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const url = await createCheckoutLink(interaction.user.id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Ir para o pagamento')
        .setStyle(ButtonStyle.Link)
        .setURL(url)
    );
    await interaction.editReply({
      content:
        `**${PRODUCT_NAME}** — ${brl(PRICE_CENTS)}\n` +
        'Clique no botão abaixo para pagar (Pix ou cartão). ' +
        'Assim que o pagamento for aprovado, o cargo VIP é liberado automaticamente.',
      components: [row],
    });
  } catch {
    await interaction.editReply(
      'Não consegui gerar o link de pagamento agora. Tente novamente em instantes.'
    );
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('painel')
    .setDescription('Publica o painel de assinatura VIP neste canal')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName('assinar')
    .setDescription('Gera seu link de pagamento da assinatura VIP')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra até quando vai a sua assinatura VIP')
    .toJSON(),
];

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot online como ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  if (env.CLEAR_GLOBAL_COMMANDS === 'true') {
    // Apaga comandos globais antigos (de um bot anterior no mesmo aplicativo)
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log('Comandos globais antigos apagados.');
  }
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('Comandos registrados.');
  checkSubscriptions();
  setInterval(checkSubscriptions, MINUTE);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'assinar') return handleSubscribe(interaction);

      if (interaction.commandName === 'status') {
        const sub = getSub.get(interaction.user.id);
        const msg =
          sub && sub.active && sub.expires_at > Date.now()
            ? `Sua assinatura VIP está ativa até **${fmtDate(sub.expires_at)}**.`
            : 'Você não tem assinatura VIP ativa. Use **/assinar** para contratar.';
        return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      }

      if (interaction.commandName === 'painel') {
        const embed = new EmbedBuilder()
          .setTitle('⭐ Assinatura VIP')
          .setDescription(
            `Acesso VIP por **${Math.round(durationMs / DAY) || 1} dias** por ${brl(PRICE_CENTS)}.\n\n` +
              'Clique no botão abaixo, pague pelo checkout e receba o cargo automaticamente.'
          );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('assinar_vip')
            .setLabel('Assinar VIP')
            .setStyle(ButtonStyle.Success)
        );
        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: 'Painel publicado.', flags: MessageFlags.Ephemeral });
      }
    }

    if (interaction.isButton() && interaction.customId === 'assinar_vip') {
      return handleSubscribe(interaction);
    }
  } catch (err) {
    console.error('Erro na interação:', err);
    const msg = `Erro: ${err.message ?? err}. Verifique se o bot tem permissão de ver e enviar mensagens/embeds neste canal.`;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg, components: [] });
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      }
    } catch {
      /* já expirou */
    }
  }
});

// Se um assinante ativo sair e voltar ao servidor, devolve o cargo.
client.on(Events.GuildMemberAdd, async (member) => {
  const sub = getSub.get(member.id);
  if (sub && sub.active && sub.expires_at > Date.now()) {
    await member.roles.add(VIP_ROLE_ID, 'Assinatura ativa').catch(console.error);
  }
});

// Roda a cada minuto: remove cargos vencidos e envia avisos de renovação.
async function checkSubscriptions() {
  const now = Date.now();

  const expired = db
    .prepare('SELECT * FROM subscriptions WHERE active = 1 AND expires_at <= ?')
    .all(now);
  for (const sub of expired) {
    try {
      const member = await revokeRole(sub.user_id);
      db.prepare('UPDATE subscriptions SET active = 0 WHERE user_id = ?').run(sub.user_id);
      if (member) {
        await sendDM(
          member,
          'Sua assinatura VIP expirou e o cargo foi removido. ' +
            'Para renovar, use o botão **Assinar VIP** no servidor ou o comando **/assinar**.'
        );
      }
    } catch (err) {
      console.error('Erro ao remover cargo de', sub.user_id, err);
    }
  }

  const soon = db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE active = 1 AND reminded = 0 AND expires_at > ? AND expires_at <= ?`
    )
    .all(now, now + reminderMs);
  for (const sub of soon) {
    try {
      const member = await fetchMember(sub.user_id);
      if (member) {
        await sendDM(
          member,
          `Sua assinatura VIP vence em **${fmtDate(sub.expires_at)}**. ` +
            'Para renovar sem perder o tempo restante, use o botão **Assinar VIP** ou o comando **/assinar**.'
        );
      }
      db.prepare('UPDATE subscriptions SET reminded = 1 WHERE user_id = ?').run(sub.user_id);
    } catch (err) {
      console.error('Erro ao avisar', sub.user_id, err);
    }
  }
}

// ───────────────────────── Webhook (servidor HTTP) ─────────────────────────
const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.send('ok'));

app.post('/webhook/infinitepay', async (req, res) => {
  // O webhook da InfinitePay não é assinado: usamos um token secreto na URL
  // e, principalmente, confirmamos o pagamento direto na API deles.
  if (req.query.token !== WEBHOOK_SECRET) return res.sendStatus(401);

  const body = req.body ?? {};
  console.log('webhook recebido:', JSON.stringify(body));

  const orderNsu = body.order_nsu;
  const order = orderNsu ? getOrder.get(orderNsu) : null;
  if (!order) {
    return res.status(400).json({ success: false, message: 'pedido desconhecido' });
  }
  if (order.status === 'paid') {
    // Pedido já registrado como pago: garante que o cargo foi entregue
    // (caso a tentativa anterior tenha falhado ao dar o cargo).
    try {
      const sub = getSub.get(order.user_id);
      if (sub && sub.active && sub.expires_at > Date.now()) {
        await grantRole(order.user_id);
      }
      return res.status(200).json({ success: true, message: null });
    } catch (err) {
      console.error('Erro ao entregar cargo (pedido já pago):', err);
      return res.status(400).json({ success: false, message: 'erro ao dar cargo' });
    }
  }

  try {
    const transactionNsu = body.transaction_nsu;
    const slug = body.invoice_slug ?? body.slug;
    const paid = await isPaid({ orderNsu, transactionNsu, slug });
    if (!paid) {
      return res.status(400).json({ success: false, message: 'pagamento não confirmado' });
    }

    const expiresAt = settleOrder(orderNsu, order.user_id, transactionNsu);
    if (expiresAt) {
      const member = await grantRole(order.user_id);
      if (member) {
        await sendDM(
          member,
          `✅ Pagamento confirmado! Seu cargo VIP está ativo até **${fmtDate(expiresAt)}**.`
        );
      }
    }
    return res.status(200).json({ success: true, message: null });
  } catch (err) {
    console.error('Erro no webhook:', err);
    // 400 faz a InfinitePay tentar de novo.
    return res.status(400).json({ success: false, message: 'erro ao processar' });
  }
});

app.listen(PORT, () => console.log(`Servidor HTTP na porta ${PORT}`));
client.login(DISCORD_TOKEN);