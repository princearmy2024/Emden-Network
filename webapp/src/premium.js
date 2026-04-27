/**
 * Premium-Spende-System.
 *
 * Flow:
 *  - getStatus(discordId) → fragt Bot, ob User aktive Premium-Entitlement hat,
 *    Bot synchronisiert dabei automatisch die Discord-Premium-Rolle.
 *  - startPurchase() → oeffnet via Discord SDK den Kauf-Modal.
 *
 * SKU-ID ist hardcoded weil das ein einziges Premium-Produkt ist.
 */
import { api } from './ui/views/api.js';
import { getSdk } from './auth.js';

const SKU_ID = '1498325834338144297';

let cached = null;
let cachedAt = 0;

export async function getStatus(discordId, { force = false } = {}) {
  if (!force && cached && (Date.now() - cachedAt) < 30000) return cached;
  try {
    const d = await api(`/premium/status?discordId=${encodeURIComponent(discordId)}`);
    cached = d;
    cachedAt = Date.now();
    return d;
  } catch(e) {
    return { active: false, error: e.message };
  }
}

export function clearCache() {
  cached = null;
  cachedAt = 0;
}

/**
 * Oeffnet den Discord-Kauf-Modal. SDK ist nur im echten Discord-Embed
 * verfuegbar — im Dev-Modus (ohne ?frame_id) wird eine Info-Toast geworfen.
 */
export async function startPurchase() {
  const sdk = getSdk();
  if (!sdk?.commands?.startPurchase) {
    throw new Error('Im Dev-Modus nicht verfuegbar — bitte in Discord testen');
  }
  return await sdk.commands.startPurchase({ sku_id: SKU_ID });
}

export function getSkuId() { return SKU_ID; }
