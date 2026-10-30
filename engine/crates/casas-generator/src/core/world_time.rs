//! How long an epoch represents, per era, and the continuous epoch
//! axis every crust-age stamp lies on.

pub const ARCHEAN_MA_PER_EPOCH: f64 = 5.0;
pub const TECTONIC_MA_PER_EPOCH: f64 = 1.0;

/// Total elapsed world age in millions of years.
pub fn world_age_ma(archean_epochs: f64, tectonic_epochs: f64) -> f64 {
    archean_epochs * ARCHEAN_MA_PER_EPOCH + tectonic_epochs * TECTONIC_MA_PER_EPOCH
}

/// Epochs since the world began, across the hand-over.
pub fn world_epoch(archean_epochs: f64, tectonic_epochs: f64) -> f64 {
    archean_epochs + tectonic_epochs
}

/// The world age, Ma, at which a stamp on the continuous epoch axis was
/// made.
pub fn world_epoch_ma(stamp: f64, archean_epochs: f64) -> f64 {
    if stamp <= archean_epochs {
        stamp * ARCHEAN_MA_PER_EPOCH
    } else {
        archean_epochs * ARCHEAN_MA_PER_EPOCH + (stamp - archean_epochs) * TECTONIC_MA_PER_EPOCH
    }
}
