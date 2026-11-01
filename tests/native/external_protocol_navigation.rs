#[allow(dead_code)]
#[path = "../../src/external_protocol.rs"]
mod external_protocol;
fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    assert_eq!(args.len(), 2);
    print!(
        "{}",
        external_protocol::renderer_navigation(&args[0], &args[1])
    );
}
