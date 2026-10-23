//! Extraction templates such as `your application to {role} at {company}`:
//! literal parts match case-insensitively, placeholders capture the shortest
//! text (never across a line break) up to the next literal or the line end.

const MAX_CAPTURE: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Literal(Vec<char>),
    Slot(Slot),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Company,
    Role,
    Location,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Captures {
    pub company: Option<String>,
    pub role: Option<String>,
    pub location: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Template(Vec<Token>);

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

impl Template {
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut tokens = Vec::new();
        let mut rest = text;
        while !rest.is_empty() {
            match rest.find('{') {
                Some(0) => {
                    let end = rest.find('}').ok_or("unclosed placeholder")?;
                    let slot = match &rest[1..end] {
                        "company" => Slot::Company,
                        "role" => Slot::Role,
                        "location" => Slot::Location,
                        other => return Err(format!("unknown placeholder {other}")),
                    };
                    if matches!(tokens.last(), Some(Token::Slot(_))) {
                        return Err("adjacent placeholders".into());
                    }
                    tokens.push(Token::Slot(slot));
                    rest = &rest[end + 1..];
                }
                found => {
                    let end = found.unwrap_or(rest.len());
                    tokens.push(Token::Literal(rest[..end].chars().map(lower).collect()));
                    rest = &rest[end..];
                }
            }
        }
        if !tokens.iter().any(|t| matches!(t, Token::Slot(_))) {
            return Err("no placeholder".into());
        }
        Ok(Self(tokens))
    }

    /// First match in `text` (any line for a leading placeholder).
    pub fn find(&self, text: &str) -> Option<Captures> {
        let chars: Vec<char> = text.chars().collect();
        for start in 0..chars.len() {
            let candidate = match &self.0[0] {
                // A leading word starts at a word boundary ("our" not in "your").
                Token::Literal(lit) => {
                    starts_with(&chars, start, lit)
                        && (start == 0
                            || !lit[0].is_alphanumeric()
                            || !chars[start - 1].is_alphanumeric())
                }
                Token::Slot(_) => start == 0 || chars[start - 1] == '\n',
            };
            if !candidate {
                continue;
            }
            let mut caps = Captures::default();
            if self.matches(0, &chars, start, &mut caps) {
                return Some(caps);
            }
        }
        None
    }

    fn matches(&self, index: usize, text: &[char], pos: usize, caps: &mut Captures) -> bool {
        let Some(token) = self.0.get(index) else {
            return true;
        };
        match token {
            Token::Literal(lit) => {
                starts_with(text, pos, lit) && self.matches(index + 1, text, pos + lit.len(), caps)
            }
            Token::Slot(slot) => {
                let line_end = text[pos..]
                    .iter()
                    .position(|&c| c == '\n')
                    .map_or(text.len(), |p| pos + p);
                let limit = line_end.min(pos + MAX_CAPTURE);
                if index + 1 == self.0.len() {
                    if line_end - pos > MAX_CAPTURE {
                        return false;
                    }
                    return set(caps, *slot, &text[pos..line_end]);
                }
                for end in pos + 1..=limit {
                    if let Some(Token::Literal(next)) = self.0.get(index + 1) {
                        if !starts_with(text, end, next) {
                            continue;
                        }
                    }
                    let mut attempt = caps.clone();
                    if set(&mut attempt, *slot, &text[pos..end])
                        && self.matches(index + 1, text, end, &mut attempt)
                    {
                        *caps = attempt;
                        return true;
                    }
                }
                false
            }
        }
    }
}

fn starts_with(text: &[char], pos: usize, lit: &[char]) -> bool {
    text.len() >= pos + lit.len()
        && text[pos..pos + lit.len()]
            .iter()
            .zip(lit)
            .all(|(a, b)| lower(*a) == *b)
}

/// Store a cleaned capture; refuse empty values and links.
fn set(caps: &mut Captures, slot: Slot, value: &[char]) -> bool {
    let value: String = value.iter().collect();
    let mut value = value.as_str();
    loop {
        let next = value
            .trim()
            .trim_matches(|c: char| matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’'))
            .trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if next == value {
            break;
        }
        value = next;
    }
    if value.is_empty() || value.contains("://") || value.chars().count() > 100 {
        return false;
    }
    let field = match slot {
        Slot::Company => &mut caps.company,
        Slot::Role => &mut caps.role,
        Slot::Location => &mut caps.location,
    };
    *field = Some(value.to_owned());
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subject_and_multi_line_templates() {
        let t = Template::parse("your application to {role} at {company}").unwrap();
        let c = t
            .find("Your application to Data Engineer at Contoso Analytics")
            .unwrap();
        assert_eq!(c.role.as_deref(), Some("Data Engineer"));
        assert_eq!(c.company.as_deref(), Some("Contoso Analytics"));
        let t = Template::parse("{role}\n{company} · {location}").unwrap();
        let c = t
            .find("Your application was sent\n\nBackend Engineer (Rust)\nAcme Robotics GmbH · Berlin, Germany (Hybrid)\n")
            .unwrap();
        assert_eq!(c.role.as_deref(), Some("Backend Engineer (Rust)"));
        assert_eq!(c.company.as_deref(), Some("Acme Robotics GmbH"));
        assert_eq!(c.location.as_deref(), Some("Berlin, Germany (Hybrid)"));
    }

    #[test]
    fn captures_are_shortest_and_cleaned() {
        let t = Template::parse("position at {company}.").unwrap();
        let c = t
            .find("the Platform Engineer position at Northwind Labs. We have")
            .unwrap();
        assert_eq!(c.company.as_deref(), Some("Northwind Labs"));
        let t = Template::parse("thank you for applying to {company}").unwrap();
        assert_eq!(
            t.find("Thank you for applying to “Litware”!")
                .unwrap()
                .company
                .as_deref(),
            Some("Litware")
        );
        assert!(t
            .find("thank you for applying to https://x.example")
            .is_none());
    }

    #[test]
    fn invalid_templates_are_refused() {
        assert!(Template::parse("no placeholder").is_err());
        assert!(Template::parse("{role}{company}").is_err());
        assert!(Template::parse("{salary} at x").is_err());
        assert!(Template::parse("{role").is_err());
    }
}
