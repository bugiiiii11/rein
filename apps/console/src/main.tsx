import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Claim } from './components/Claim';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    {window.location.pathname === '/claim' ? <Claim /> : <App />}
  </StrictMode>,
);
