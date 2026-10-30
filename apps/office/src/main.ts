import * as THREE from 'three';
import { drawBuild, drawIdleScreen, drawScore, drawTerminal, drawTickets } from './boards.ts';
import { buildOffice } from './office.ts';
import './style.css';

const world = buildOffice(document.getElementById('stage')!);

drawTickets(world.tickets, 'SHOP-42', 'Cart and checkout for ShopLite', [
  { id: 'AC-1', text: 'Add to cart: the cart badge shows 1' },
  { id: 'AC-2', text: 'Quantity 2: the cart total shows ₹698' },
  { id: 'AC-3', text: 'Checkout: "Order placed" is shown' },
]);
drawScore(world.score, null);
drawBuild(world.build, 'Nothing running', ['Pick a scenario to start an episode.']);
for (const d of Object.values(world.desks)) {
  drawIdleScreen(d.browser, d.id === 'rival' ? 'Fixer' : 'Sentinel', d.id === 'rival' ? '#b3a4ff' : '#ffb38a', 'waiting for a build');
  drawTerminal(d.terminal, d.id === 'rival' ? 'fixer@office' : 'sentinel@office', [{ text: '$ ready', tone: 'dim' }]);
  d.tag.innerHTML = `<div class="bubble"><span class="state s-idle">IDLE</span><div class="head">waiting</div></div><div class="name">${d.id === 'rival' ? 'Fixer' : 'Sentinel'}</div>`;
}

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  world.tick(dt);
  world.controls.update();
  world.renderer.render(world.scene, world.camera);
  world.labels.render(world.scene, world.camera);
  requestAnimationFrame(frame);
}
frame();
