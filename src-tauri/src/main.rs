#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    krill_system_monitor_lib::run();
}
