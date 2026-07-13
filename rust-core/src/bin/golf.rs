use std::env;
use std::fs;
use std::io::{self, Read};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args: Vec<String> = env::args().skip(1).collect();
    let aggressive = if let Some(pos) = args.iter().position(|a| a == "-a" || a == "--aggressive") {
        args.remove(pos);
        true
    } else {
        false
    };

    let source = if let Some(path) = args.first() {
        match fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("erreur de lecture de {path}: {e}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        let mut s = String::new();
        if io::stdin().read_to_string(&mut s).is_err() {
            eprintln!("aucune entree fournie (fichier en argument ou stdin)");
            return ExitCode::FAILURE;
        }
        s
    };

    let result = glsl_golf_core::golf(&source, aggressive);
    eprintln!(
        "-- {} -> {} caracteres ({:.1}% de reduction, {} identifiants renommes, {} nombres raccourcis{})",
        result.stats.input_chars,
        result.stats.output_chars,
        result.stats.reduction_pct,
        result.stats.renamed_count,
        result.stats.numbers_shortened,
        if aggressive {
            format!(
                ", {} locaux morts supprimes, {} ecritures mortes supprimees, {} constantes repliees, {} affectations composees, {} declarations fusionnees, {} blocs d'accolades supprimes",
                result.stats.aggressive.dead_locals_removed,
                result.stats.aggressive.dead_stores_removed,
                result.stats.aggressive.constants_folded,
                result.stats.aggressive.compound_assignments,
                result.stats.aggressive.declarations_merged,
                result.stats.aggressive.braces_removed,
            )
        } else {
            String::new()
        },
    );
    println!("{}", result.code);
    ExitCode::SUCCESS
}
