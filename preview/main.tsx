import { useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { FaBatteryThreeQuarters, FaCog, FaPlug, FaSlidersH, FaStore, FaVolumeUp, FaWifi } from "react-icons/fa";
import plugin from "../src/index";
import { closeTopModal, getModals, getToasts, subscribe } from "./modalHost";
import * as nav from "./nav";

const params = new URLSearchParams(location.search);
if (params.get("tall") === "1") document.documentElement.classList.add("tall");

const ModalLayer = () => {
  const modals = useSyncExternalStore(subscribe, getModals);
  const count = useRef(modals.length);
  useEffect(() => {
    if (modals.length > count.current) nav.onModalOpened();
    if (modals.length < count.current) nav.onModalClosed();
    count.current = modals.length;
  }, [modals.length]);

  return (
    <>
      {modals.map((modal) => (
        <div key={modal.id} className="mock-modal-layer">
          {modal.render(() => closeTopModal(modal.id))}
        </div>
      ))}
    </>
  );
};

const ToastLayer = () => {
  const toasts = useSyncExternalStore(subscribe, getToasts);
  return (
    <div className="mock-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className={`mock-toast ${toast.critical ? "critical" : ""}`}>
          <div className="mock-toast-title">{toast.title}</div>
          <div className="mock-toast-body">{toast.body}</div>
        </div>
      ))}
    </div>
  );
};

const App = () => (
  <>
    <div className="qam">
      <div className="qam-rail">
        {[FaBatteryThreeQuarters, FaSlidersH, FaWifi, FaVolumeUp, FaCog, FaStore].map((Icon, i) => (
          <div key={i} className="qam-rail-icon">
            <Icon />
          </div>
        ))}
        <div className="qam-rail-icon active">
          <FaPlug />
        </div>
      </div>
      <div className="qam-pane">
        <div className="qam-header">
          <span className="qam-back">‹</span>
          {plugin.titleView}
        </div>
        <div id="qam-content" className="qam-content">
          {plugin.content}
        </div>
      </div>
    </div>
    <ModalLayer />
    <ToastLayer />
  </>
);

nav.installKeyboard(() => {
  if (getModals().length) closeTopModal();
});
(window as unknown as { __nav: typeof nav }).__nav = nav;

createRoot(document.getElementById("root")!).render(<App />);
