/** The popup: import, add, edit, delete, search and export of the list. */
import { parsePeopleCsv, writePeopleCsv } from './csv';
import * as store from './store';
import { MissingIdColumnError, type PersonRecord } from './types';

const fileInput = document.getElementById('import-file') as HTMLInputElement;
const searchInput = document.getElementById('search') as HTMLInputElement;
const addIdInput = document.getElementById('add-id') as HTMLInputElement;
const addNameInput = document.getElementById('add-name') as HTMLInputElement;
const addButton = document.getElementById('add-button') as HTMLButtonElement;
const exportButton = document.getElementById('export-button') as HTMLButtonElement;
const deleteAllButton = document.getElementById('delete-all-button') as HTMLButtonElement;
const messageEl = document.getElementById('message') as HTMLDivElement;
const listEl = document.getElementById('list') as HTMLUListElement;
const versionEl = document.getElementById('version') as HTMLSpanElement;

let currentPeople: PersonRecord[] = [];

function setMessage(text: string): void {
  messageEl.textContent = text;
}

/** `1 row`, `2 rows`. Never shows the literal "(s)" a count of one or many both used to show. */
function plural(count: number, word: string): string {
  return count === 1 ? `${count} ${word}` : `${count} ${word}s`;
}

function renderList(): void {
  const filtered = store.search(currentPeople, searchInput.value);
  listEl.innerHTML = '';
  if (filtered.length === 0) {
    const empty = document.createElement('li');
    empty.textContent =
      currentPeople.length === 0 ? 'No people added yet. Import a CSV or add one above.' : 'No match for this search.';
    listEl.append(empty);
    return;
  }
  for (const person of filtered) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${person.name} (${person.id})`;
    const actions = document.createElement('span');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => onEdit(person));
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => onDelete(person.id));
    actions.append(editBtn, deleteBtn);
    li.append(label, actions);
    listEl.append(li);
  }
}

async function refresh(): Promise<void> {
  currentPeople = await store.getAll();
  renderList();
}

async function onEdit(person: PersonRecord): Promise<void> {
  const name = window.prompt(`Name for ${person.id}`, person.name);
  if (name === null || name.trim().length === 0) {
    return;
  }
  await store.upsertOne({ id: person.id, name: name.trim() });
  await refresh();
}

async function onDelete(id: string): Promise<void> {
  await store.deleteOne(id);
  await refresh();
}

addButton.addEventListener('click', async () => {
  const id = addIdInput.value.trim().toLowerCase();
  const name = addNameInput.value.trim();
  if (id.length === 0 || name.length === 0) {
    setMessage('Enter both a username or reference and a name.');
    return;
  }
  await store.upsertOne({ id, name });
  addIdInput.value = '';
  addNameInput.value = '';
  setMessage(`Added ${name}.`);
  await refresh();
});

searchInput.addEventListener('input', renderList);

deleteAllButton.addEventListener('click', async () => {
  if (!window.confirm('Delete the whole list? This cannot be undone.')) {
    return;
  }
  await store.deleteAll();
  setMessage('Deleted the whole list.');
  await refresh();
});

exportButton.addEventListener('click', () => {
  const csv = writePeopleCsv(currentPeople);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'zero-trust-translator-export.csv';
  a.click();
  URL.revokeObjectURL(url);
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) {
    return;
  }
  const text = await file.text();
  let parsed;
  try {
    parsed = parsePeopleCsv(text);
  } catch (error) {
    if (error instanceof MissingIdColumnError) {
      setMessage(error.message);
      return;
    }
    throw error;
  }
  const existingIds = await store.findExistingIds(parsed.imported);
  if (existingIds.length > 0) {
    const proceed = window.confirm(`${plural(existingIds.length, 'row')} already in the list will be replaced. Continue?`);
    if (!proceed) {
      setMessage('Import cancelled. The list is unchanged.');
      return;
    }
  }
  await store.upsertMany(parsed.imported);
  const skippedText = parsed.skipped.length > 0 ? `, skipped ${parsed.skipped.length} (${parsed.skipped.map((s) => `row ${s.row}: ${s.reason}`).join('; ')})` : '';
  setMessage(`Imported ${plural(parsed.imported.length, 'row')}${skippedText}.`);
  await refresh();
});

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

void refresh();
