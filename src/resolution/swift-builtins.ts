/**
 * Swift standard-library name lists the resolver reads:
 *
 * - SWIFT_STD_METHODS: methods of the stdlib, Foundation, UIKit and Combine
 *   that a call needs receiver evidence for (below).
 * - SWIFT_RAW_VALUE_TYPES: stdlib types that, named in an enum's inheritance
 *   clause, are its raw-value type (`enum K: String`); the static-call
 *   supertype walk does not follow them from an enum (swift-type-visibility.ts,
 *   swiftSupertypeChain).
 */

/**
 * Methods of Swift's standard collections, strings and optionals, and of
 * Foundation, UIKit views and Combine — names a project type rarely carries
 * itself. A call by one of these names needs receiver evidence before it
 * resolves to a project member: name-matcher's Swift chained-call test
 * (`isSwiftCallTarget`) and its single-candidate fallback for an untyped
 * receiver (`stdMethodNames`) both read it. Where the chained-call test can
 * read the receiver's type, it keeps only that type's member or its
 * supertypes'; otherwise it keeps a member the receiver names, an outside-type
 * member, or one declaring the call's label. The fallback keeps a member the
 * receiver names, or an outside-type member whose parameter labels the call's
 * arguments fit.
 * Names a project type often carries (`cancel`, `resume`, `store`, `validate`,
 * `load`) are left out: Alamofire's `request.resume()`, Kingfisher's
 * `cache.store(…)`.
 */
export const SWIFT_STD_METHODS: ReadonlySet<string> = new Set([
  'append', 'insert', 'remove', 'removeAll', 'removeFirst', 'removeLast', 'removeValue', 'contains', 'map',
  'compactMap', 'flatMap', 'filter', 'reduce', 'forEach', 'sorted', 'sort', 'first', 'last', 'min', 'max',
  'firstIndex', 'lastIndex', 'index', 'enumerated', 'reversed', 'joined', 'split', 'prefix', 'suffix',
  'dropFirst', 'dropLast', 'allSatisfy', 'randomElement', 'shuffled', 'popLast', 'replaceSubrange',
  'replacingOccurrences', 'components', 'trimmingCharacters', 'hasPrefix', 'hasSuffix', 'lowercased',
  'uppercased', 'appending', 'updateValue', 'merge', 'merging', 'union', 'intersection', 'subtracting',
  'formUnion', 'isEqual', 'addSubview', 'removeFromSuperview', 'setNeedsDisplay', 'setNeedsLayout',
  'layoutIfNeeded', 'addGestureRecognizer', 'addTarget', 'addObserver', 'removeObserver', 'eraseToAnyPublisher',
]);

/** Whether `name` is in `SWIFT_STD_METHODS`. */
export function isSwiftStdMethodName(name: string): boolean {
  return SWIFT_STD_METHODS.has(name);
}

/**
 * Swift's raw-value types by their stdlib names: String, Character, Bool, and
 * the integer and floating-point families. Each is a stdlib struct, and an
 * enum inherits from no class and nothing conforms to a struct, so an entry
 * of an enum's inheritance clause naming one of them is the enum's raw type
 * (`enum K: String`), never a supertype. That holds wherever the entry sits
 * in the clause, so no position data is needed to tell it apart.
 */
export const SWIFT_RAW_VALUE_TYPES: ReadonlySet<string> = new Set([
  'String', 'Character', 'Bool',
  'Int', 'Int8', 'Int16', 'Int32', 'Int64',
  'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
  'Double', 'Float', 'Float16', 'Float80',
]);
