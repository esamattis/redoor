//! Mutual proof of the agent token between an agent and the server.
//!
//! The token never crosses the network, so an agent pointed at a wrong or fraudulent server
//! does not hand it the secret, and refuses to take commands from a server that cannot prove
//! it knows the token. Each side proves knowledge with an HMAC over fresh nonces instead:
//!
//! 1. The upgrade request carries the agent's nonce and an HMAC over it. It is replayable, so
//!    it only keeps everyone without the token (or a captured request) from getting a socket
//!    or a server proof.
//! 2. The `101` answer carries the server's nonce and an HMAC over both nonces. The agent's
//!    nonce is fresh, so only a holder of the token can produce it for this connection.
//! 3. The `hello` carries the agent's HMAC over both nonces. The server's nonce is fresh, so a
//!    replayed upgrade request cannot complete the handshake.
//!
//! Without TLS between the agent and the server this cannot stop an active man in the middle
//! that relays the proofs to the real server, because the frames after the handshake are not
//! bound to it.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Upgrade request header carrying the agent's nonce.
pub const AGENT_NONCE_HEADER: &str = "x-redoor-agent-nonce";
/// Upgrade request header carrying the agent's proof over its own nonce.
pub const AGENT_PROOF_HEADER: &str = "x-redoor-agent-proof";
/// Upgrade response header carrying the server's nonce.
pub const SERVER_NONCE_HEADER: &str = "x-redoor-server-nonce";
/// Upgrade response header carrying the server's proof over both nonces.
pub const SERVER_PROOF_HEADER: &str = "x-redoor-server-proof";

/// Random bytes in one nonce; enough that a nonce never repeats, so no proof can be reused
/// for another connection.
const NONCE_BYTES: usize = 32;

/// Encodes bytes as lowercase hex, the form nonces and proofs take in headers and JSON.
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One side's fresh random value, which makes the other side's proof unique to this
/// connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeNonce(String);

impl HandshakeNonce {
    /// Draws a new nonce from the operating system's random source.
    pub fn generate() -> Self {
        let mut bytes = [0u8; NONCE_BYTES];
        getrandom::fill(&mut bytes).expect("the operating system random source is unavailable");
        Self(to_hex(&bytes))
    }

    /// Accepts only the exact generated form, so a peer cannot make the server hash large or
    /// ambiguous input.
    pub fn parse(value: &str) -> Option<Self> {
        let well_formed = value.len() == NONCE_BYTES * 2
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
        well_formed.then(|| Self(value.to_string()))
    }

    /// The hex form sent on the wire.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The nonces of both sides of one connection, which the server and the `hello` proofs cover.
#[derive(Debug, Clone)]
pub struct HandshakeNonces {
    pub agent: HandshakeNonce,
    pub server: HandshakeNonce,
}

/// The step a proof belongs to. Each step has its own label, so a proof of one step can never
/// be replayed as another, for example the server's proof reflected back as the agent's.
#[derive(Debug, Clone, Copy)]
enum ProofStep {
    AgentUpgrade,
    Server,
    AgentHello,
}

impl ProofStep {
    /// Domain-separation label hashed in front of the nonces.
    fn label(self) -> &'static str {
        match self {
            Self::AgentUpgrade => "redoor agent upgrade",
            Self::Server => "redoor server",
            Self::AgentHello => "redoor agent hello",
        }
    }
}

/// The agent token as the HMAC key both sides prove knowledge of.
#[derive(Clone)]
pub struct AgentTokenKey {
    /// Keyed once and cloned per proof, so the token is not kept around as a string.
    mac: Hmac<Sha256>,
}

impl AgentTokenKey {
    /// Keys the proofs with `token`.
    pub fn new(token: &str) -> Self {
        Self {
            mac: <Hmac<Sha256> as KeyInit>::new_from_slice(token.as_bytes())
                .expect("HMAC accepts any key length"),
        }
    }

    /// The agent's proof in the upgrade request.
    pub fn upgrade_proof(&self, agent: &HandshakeNonce) -> TokenProof {
        self.prove(ProofStep::AgentUpgrade, &[agent.as_str()])
    }

    /// The server's proof in the `101` answer.
    pub fn server_proof(&self, nonces: &HandshakeNonces) -> TokenProof {
        self.prove(
            ProofStep::Server,
            &[nonces.agent.as_str(), nonces.server.as_str()],
        )
    }

    /// The agent's proof in its `hello`.
    pub fn hello_proof(&self, nonces: &HandshakeNonces) -> TokenProof {
        self.prove(
            ProofStep::AgentHello,
            &[nonces.agent.as_str(), nonces.server.as_str()],
        )
    }

    /// HMACs the step label and the nonces, one per line. Nonces are fixed-length hex, so the
    /// encoding is unambiguous.
    fn prove(&self, step: ProofStep, nonces: &[&str]) -> TokenProof {
        let mut mac = self.mac.clone();
        mac.update(step.label().as_bytes());
        for nonce in nonces {
            mac.update(b"\n");
            mac.update(nonce.as_bytes());
        }
        TokenProof(to_hex(&mac.finalize().into_bytes()))
    }
}

/// One expected or computed proof in its hex wire form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenProof(String);

impl TokenProof {
    /// The hex form sent on the wire.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Compares a presented proof in constant time, so timing does not reveal how much of a
    /// guess was right.
    pub fn matches(&self, presented: &str) -> bool {
        bool::from(self.0.as_bytes().ct_eq(presented.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds the nonces of one connection.
    fn nonces() -> HandshakeNonces {
        HandshakeNonces {
            agent: HandshakeNonce::generate(),
            server: HandshakeNonce::generate(),
        }
    }

    /// Verifies the proofs match only for the same token, step and nonces.
    #[test]
    fn proofs_depend_on_token_step_and_nonces() {
        let key = AgentTokenKey::new("token");
        let nonces = nonces();
        let server = key.server_proof(&nonces);
        // The other side computes the same value from the same token and nonces.
        assert!(server.matches(AgentTokenKey::new("token").server_proof(&nonces).as_str()));
        // A server without the token cannot produce the proof.
        assert!(!server.matches(AgentTokenKey::new("other").server_proof(&nonces).as_str()));
        // The server's proof cannot be reflected back as the agent's hello proof.
        assert!(!key.hello_proof(&nonces).matches(server.as_str()));
        // A proof for another connection's nonces is useless for this one.
        assert!(!server.matches(key.server_proof(&self::nonces()).as_str()));
        // Truncated or empty input never matches.
        assert!(!server.matches(&server.as_str()[1..]));
        assert!(!server.matches(""));
    }

    /// Verifies the HMAC input against a fixed value, which the TypeScript test agents must
    /// reproduce byte for byte.
    #[test]
    fn upgrade_proof_has_a_stable_encoding() {
        let nonce = HandshakeNonce::parse(&"ab".repeat(NONCE_BYTES)).unwrap();
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(b"token").unwrap();
        mac.update(format!("redoor agent upgrade\n{}", "ab".repeat(NONCE_BYTES)).as_bytes());
        // The label and the nonce, separated by a newline, are the whole HMAC input.
        assert_eq!(
            AgentTokenKey::new("token").upgrade_proof(&nonce).as_str(),
            to_hex(&mac.finalize().into_bytes())
        );
    }

    /// Verifies only the generated nonce form is accepted from a peer.
    #[test]
    fn nonce_parsing_accepts_only_the_generated_form() {
        let generated = HandshakeNonce::generate();
        // A generated nonce survives the round trip through a header.
        assert_eq!(HandshakeNonce::parse(generated.as_str()), Some(generated));
        // Wrong length, upper case and separators would make the HMAC input ambiguous or large.
        for invalid in [
            "",
            "ab",
            &"AB".repeat(NONCE_BYTES),
            &format!("{}\n", "a".repeat(NONCE_BYTES * 2 - 1)),
            &"a".repeat(NONCE_BYTES * 4),
        ] {
            assert_eq!(HandshakeNonce::parse(invalid), None, "{invalid:?}");
        }
    }
}
