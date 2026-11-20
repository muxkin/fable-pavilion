fn main() {
    if let Err(error) = agent_space_native::run_antigravity_plugin() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
