use std::path::{Component, Path, PathBuf};

/// The path with `.` and `..` worked out from its text alone, like Node's `path.resolve`; links are not followed.
fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// A directory an agent may read and write. Paths outside it are rejected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// The workspace at `root`; a relative one counts from the current folder.
    pub fn new(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref();
        let absolute = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
        Self {
            root: normalized(&absolute),
        }
    }

    /// The workspace's folder.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A path the agent asked for, from the workspace's folder. This judges the path's text; see `saturn-tools` for links.
    pub fn resolve(&self, requested: &str) -> Result<PathBuf, String> {
        let target = normalized(&self.root.join(requested));
        if !target.starts_with(&self.root) {
            return Err("Path is outside the workspace".to_owned());
        }
        Ok(target)
    }

    /// A path inside the workspace as the agent is shown it: with forward slashes on every system, as it is written.
    pub fn relative(&self, target: &Path) -> String {
        match target.strip_prefix(&self.root) {
            Ok(relative) if !relative.as_os_str().is_empty() => relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
            Ok(_) => ".".to_owned(),
            Err(_) => target.to_string_lossy().into_owned(),
        }
    }
}
