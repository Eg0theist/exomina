// Read-only REA Ghidra operations. This module never loads a native addon.
export const NATIVE_QUERIES = Object.freeze([
  'inspect_native_load_image', 'read_bytes', 'address_to_file_offset', 'address_name',
  'list_documents', 'list_names', 'list_procedures', 'list_segments', 'list_strings',
  'procedure_address', 'resolve_containing_procedure', 'search_procedures', 'search_strings',
  'inspect_native_data_type', 'inspect_native_instruction', 'resolve_native_call_targets',
  'analyze_function', 'procedure_assembly', 'procedure_callees', 'procedure_callers',
  'procedure_info', 'procedure_pseudo_code', 'read_function_instructions', 'procedure_references', 'xrefs',
]);
export const NATIVE_OPERATIONS = Object.freeze(['native', 'native-functions', 'native-query']);
export const NATIVE_TARGET_SCOPE = 'Exomina currently integrates experimental native Windows x86/x64 EXE analysis. Native DLLs, other binary formats and other architectures are not yet integrated and verified in Exomina; Ghidra itself supports a wider range of targets.';
