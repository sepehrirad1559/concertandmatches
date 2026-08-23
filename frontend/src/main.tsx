import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from "./App.jsx";

// BrowserRouter enables real, shareable/bookmarkable per-event URLs
// (/event/:id-:slug — see App.jsx) instead of everything living behind one
// "/" route with in-memory-only state. vercel.json's SPA fallback rewrite
// is what makes a direct load or refresh of one of those URLs work.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)