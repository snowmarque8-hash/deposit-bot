// doordash-group.js — Reads DoorDash group orders and calculates 90% promo prices

async function fetchGroupOrder(url) {
  try {
    const token = process.env.DOORDASH_TOKEN;
    if (!token) throw new Error('DOORDASH_TOKEN not set');

    // Extract group order UUID from URL
    // Handles: doordash.com/group-order/UUID or doordash.com/share/group-order/UUID
    const uuidMatch = url.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
    if (!uuidMatch) throw new Error('Could not find group order ID in URL');
    const groupOrderId = uuidMatch[0];

    // Try DoorDash API directly
    const apiUrl = `https://www.doordash.com/api/v2/group_orders/${groupOrderId}/`;

    const res = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token.split(':')[0]}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'application/json',
        'x-channel-id': 'doordash',
        'Cookie': `ddweb_token=${token}`,
      },
    });

    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function applyPromo(price, discountPercent = 90) {
  const discount = price * (discountPercent / 100);
  const final = price - discount;
  return {
    original: price.toFixed(2),
    discount: discount.toFixed(2),
    final: final.toFixed(2),
  };
}

module.exports = { fetchGroupOrder, applyPromo };
