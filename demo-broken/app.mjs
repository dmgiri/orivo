import { request, bind, derive } from '/trace/browser.mjs';
const sources = await fetch('/trace/sources.json').then(response => response.json());
const catalog = await request('/api/catalog');
const formatMoney = amount => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
const container = document.querySelector('#products'); container.replaceChildren();
for (const [index, product] of catalog.data.products.entries()) {
  const card = document.createElement('article'); card.className = `product product-${product.id}`;
  card.innerHTML = `<div class="details"><div><h2></h2><p>${product.subtitle}</p></div><span class="price"></span></div>`;
  const name = card.querySelector('h2'); name.dataset.traceId = `name-${product.id}`; name.textContent = product.name; bind(name, sources.name, [catalog.field(`products.${index}.name`)]); // trace:name
  const price = card.querySelector('.price'); price.dataset.traceId = `price-${product.id}`; const money = derive([catalog.field(`products.${index}.price`)], formatMoney); price.textContent = money.value; bind(price, sources.price, [money]); // trace:price
  container.append(card);
}
document.documentElement.dataset.traceReady = 'true';
