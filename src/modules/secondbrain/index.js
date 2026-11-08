import { registerModule } from '../../shell/modules.js';
import { notesSearchProvider } from '../../core/search.js';

registerModule({
  id: 'secondbrain',
  name: 'Second Brain',
  icon: '🧠',
  ready: true,
  searchProvider: notesSearchProvider,
  render(root) {
    root.textContent = 'Second Brain';
  },
});
