// Load the dashboard styles before rendering the React application.
import "./styles.css";
import { createRoot } from "react-dom/client";
import App from "./app";

// Vite serves index.html with a root element. React mounts the App component there.
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root was not found");

createRoot(rootElement).render(<App />);
