import { registerModule } from './modules.js';

const soon = [
  ['cooking', 'Cooking Coach', '🍳', 'What can I cook tonight, timers, macros and cost.'],
  ['money', 'Money Sandbox', '💰', 'What-if simulator for big money decisions.'],
  ['skills', 'Skill Tree', '🌳', 'Learning goals, practice log and flashcards.'],
  ['photos', 'Photo Vault', '🖼️', 'Private photo timeline and trip albums.'],
  ['journal', 'Journal Companion', '📓', 'Weekly reflection and pattern spotting.'],
];

for (const [id, name, icon, blurb] of soon) {
  registerModule({
    id, name, icon, ready: false,
    render(root) {
      root.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'soon';
      const h = document.createElement('h2');
      h.textContent = `${icon} ${name}`;
      const p = document.createElement('p');
      p.textContent = `Coming soon. ${blurb}`;
      box.append(h, p);
      root.append(box);
    },
  });
}
