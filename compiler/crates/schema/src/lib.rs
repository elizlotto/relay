/*
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

//! This crate contains a Schema representation and a parser to parse a
//! GraphQL SDL string into a [`Schema`] instance.

#![deny(warnings)]
#![deny(rust_2018_idioms)]
#![deny(clippy::all)]

mod definitions;
mod errors;
mod lexer;
mod parser;
mod token;

pub use definitions::{
    Argument, ArgumentDefinitions, ArgumentValue, Directive, DirectiveValue, Enum, EnumID,
    EnumValue, Field, FieldID, InputObject, InputObjectID, Interface, InterfaceID, Object,
    ObjectID, Scalar, ScalarID, Schema, Type, TypeReference, TypeWithFields, Union, UnionID,
};
pub use errors::{Result, SchemaError};
pub use graphql_syntax::type_system_node::{
    Directive as DirectiveDefinition, DirectiveLocation, FieldDefinition, InputValueDefinition,
    Type as AstType, TypeSystemDefinition, Value as AstValue,
};
use lexer::Lexer;
use parser::Parser;

pub const BUILTINS: &str = include_str!("./builtins.graphql");

pub const RELAY_EXTENSIONS: &str = include_str!("./relay-extensions.graphql");

pub fn build_schema(sdl: &str) -> Result<Schema> {
    build_schema_with_extensions::<_, &str>(&[sdl], &[])
}

pub fn build_schema_with_extensions<T: AsRef<str>, U: AsRef<str>>(
    server_sdls: &[T],
    extension_sdls: &[U],
) -> Result<Schema> {
    let mut server_definitions = parse_definitions(BUILTINS)?;

    for server_sdl in server_sdls {
        server_definitions.extend(parse_definitions(server_sdl.as_ref())?);
    }

    let mut extension_definitions = Vec::new();
    for extension_sdl in extension_sdls {
        extension_definitions.extend(parse_definitions(extension_sdl.as_ref())?);
    }

    Schema::build(&server_definitions, &extension_definitions)
}

pub fn parse_definitions(input: &str) -> Result<Vec<TypeSystemDefinition>> {
    let lexer = Lexer::new(input);
    let parser = Parser::new(lexer);
    parser.parse_schema_document()
}
