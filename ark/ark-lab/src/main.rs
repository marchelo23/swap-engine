use ark_lab::{Action, WalletId};
use clap::{Parser, Subcommand};
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Bitcoin-only wallet operations for the isolated Arkade regtest lab")]
struct Args {
    /// Use the dedicated, one-shot E2E fixture wallets rather than operator wallets.
    #[arg(long)]
    e2e_fixture: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    InitWallets,
    Addresses {
        wallet: Option<WalletId>,
    },
    Balance {
        wallet: Option<WalletId>,
    },
    ListVtxos {
        wallet: Option<WalletId>,
    },
    Restore {
        wallet: WalletId,
    },
    Board {
        wallet: WalletId,
        input: bitcoin::OutPoint,
    },
    TransferSubmit {
        input: bitcoin::OutPoint,
        sats: u64,
    },
    Pending,
    TransferFinalize {
        txid: bitcoin::Txid,
    },
    VerifySpent {
        input: bitcoin::OutPoint,
        /// Optional legacy amount argument, ignored by the read-only spent check.
        #[arg(hide = true)]
        _sats: Option<u64>,
    },
    SettleVtxo {
        wallet: WalletId,
        input: bitcoin::OutPoint,
    },
    OffboardCoop {
        input: bitcoin::OutPoint,
        address: bitcoin::Address<bitcoin::address::NetworkUnchecked>,
        sats: u64,
    },
}

fn checked_fixture_root(repo: &Path) -> Option<PathBuf> {
    // SAFETY: geteuid takes no arguments and has no preconditions.
    let euid = unsafe { libc::geteuid() };
    let mut current = repo.to_path_buf();
    for segment in ["data", "ark", "e2e", "fixture"] {
        current.push(segment);
        let meta = std::fs::symlink_metadata(&current).ok()?;
        if !meta.is_dir() || meta.uid() != euid {
            return None;
        }
    }
    Some(current)
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();
    let (action, wallet) = match args.command {
        Command::InitWallets => (Action::Initialize, None),
        Command::Addresses { wallet } => (Action::Addresses, wallet),
        Command::Balance { wallet } => (Action::Balance, wallet),
        Command::ListVtxos { wallet } => (Action::ListVtxos, wallet),
        Command::Restore { wallet } => (Action::Restore, Some(wallet)),
        Command::Board { wallet, input } => (Action::Board(input), Some(wallet)),
        Command::TransferSubmit { input, sats } => {
            (Action::TransferSubmit(input, sats), Some(WalletId::Alice))
        }
        Command::Pending => (Action::Pending, Some(WalletId::Alice)),
        Command::TransferFinalize { txid } => {
            (Action::TransferFinalize(txid), Some(WalletId::Alice))
        }
        Command::VerifySpent { input, .. } => (Action::VerifySpent(input), Some(WalletId::Alice)),
        Command::SettleVtxo { wallet, input } => (Action::SettleVtxo(input), Some(wallet)),
        Command::OffboardCoop {
            input,
            address,
            sats,
        } => (Action::Offboard(input, address, sats), Some(WalletId::Bob)),
    };
    let both = [WalletId::Alice, WalletId::Bob];
    let repo = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));
    let fixture = if args.e2e_fixture {
        let Some(path) = checked_fixture_root(repo) else {
            eprintln!("ArkWalletStorage: fixture is created by ark:test -- --e2e");
            return ExitCode::FAILURE;
        };
        Some(path)
    } else {
        None
    };
    let repo = fixture.as_deref().unwrap_or(repo);
    let wallets = wallet
        .as_ref()
        .map_or(both.as_slice(), std::slice::from_ref);
    match ark_lab::run(repo, action, wallets).await {
        Ok(report) => {
            println!("{report:#}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn fixture_root_rejects_symlinked_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("real");
        std::fs::create_dir_all(target.join("fixture")).unwrap();
        std::fs::create_dir_all(temp.path().join("data/ark")).unwrap();
        symlink(&target, temp.path().join("data/ark/e2e")).unwrap();
        assert!(checked_fixture_root(temp.path()).is_none());

        std::fs::remove_file(temp.path().join("data/ark/e2e")).unwrap();
        std::fs::create_dir_all(temp.path().join("data/ark/e2e/fixture")).unwrap();
        assert_eq!(
            checked_fixture_root(temp.path()),
            Some(temp.path().join("data/ark/e2e/fixture"))
        );
    }
}
