import { request, bind, derive, action, local } from '/trace/browser.mjs';

const sources = await fetch('/trace/sources.json').then(response => response.json());
const catalog = await request('/api/catalog');
const formatMoney = amount => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
const container = document.querySelector('#products');
container.replaceChildren();
let count = 0;

for (const [index, product] of catalog.data.products.entries()) {
  const card = document.createElement('article');
  card.className = `product product-${product.id}`;
  card.innerHTML = `<div class="visual"><span class="edition">${String(index + 1).padStart(2, '0')}</span><div class="lamp lamp-${product.id}"><div class="glow"></div><div class="shade"></div><div class="stem"></div><div class="base"></div></div><span class="finish">${product.finish}</span></div><div class="details"><div><h2></h2><p>${product.subtitle}</p></div><span class="price"></span></div><div class="product-bottom"><span class="rating"></span><button class="add" aria-label="Add ${product.name} to bag">Add to bag <span>↗</span></button></div>`;
  const name = card.querySelector('h2');
  name.dataset.traceId = `name-${product.id}`;
  name.textContent = product.name; bind(name, sources.name, [catalog.field(`products.${index}.name`)]); // trace:name
  const price = card.querySelector('.price');
  price.dataset.traceId = `price-${product.id}`;
  const money = derive([catalog.field(`products.${index}.price`)], formatMoney); price.textContent = money.value; bind(price, sources.price, [money]); // trace:price
  const rating = card.querySelector('.rating');
  rating.dataset.traceId = `rating-${product.id}`;
  rating.textContent = `★ ${product.rating} / 5`; bind(rating, sources.rating, [catalog.field(`products.${index}.rating`)]); // trace:rating
  const button = card.querySelector('.add');
  button.dataset.traceId = `cart-${product.id}`;
  button.addEventListener('click', action(button, sources.cart, async capture => { // trace:cart
    button.disabled = true;
    try {
      const result = await capture('/api/cart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: product.id }) });
      if (!result.response.ok) throw Error('Unable to add item');
      document.querySelector('#cart-count').textContent = String(++count);
      const toast = document.querySelector('#toast'); toast.textContent = `${product.name} added to your bag`; toast.classList.add('visible');
      clearTimeout(toast.timer); toast.timer = setTimeout(() => toast.classList.remove('visible'), 2400);
      button.firstChild.textContent = 'Added ';
    } catch (error) { document.querySelector('#toast').textContent = error.message; }
    finally { button.disabled = false; }
  }));
  container.append(card);
}
bind(document.querySelector('.note'), sources.static, [local('Designed to make room for the everyday.')], 'static'); // trace:static
document.documentElement.dataset.traceReady = 'true';
