import React from "react";
import { createRoot } from "react-dom/client";
import DriveReader from "../DriveReader.jsx";
import "./style.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DriveReader />
  </React.StrictMode>,
);

