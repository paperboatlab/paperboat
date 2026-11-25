import '@paperboatlab/ui/tokens.css';
import '@paperboatlab/ui/ui.css';
import './launcher.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {createClient} from '@paperboat/client/browser';
import {App} from './App.tsx';
import {bridgeTransport} from './bridge.ts';

document.documentElement.dataset.app = 'paperboat';
const client = createClient(bridgeTransport());
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
